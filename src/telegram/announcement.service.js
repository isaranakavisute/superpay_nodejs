import { z } from 'zod';
import { query } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { internal as configOf } from '../config-admin/config.service.js';
import logger from '../logger.js';

/**
 * ประชาสัมพันธ์: messages @OptionPaySupportBot posts to every Telegram group it is in,
 * at chosen hourly slots ('times') or every N seconds/minutes/hours from a start ('interval'),
 * Bangkok time. The scheduler checks every 5 seconds; each slot is claimed in announcement_runs first, so it
 * is posted once even across restarts or two servers.
 */
const TZ_OFFSET_MS = 7 * 3_600_000;   // Asia/Bangkok (no DST)
const HOUR = 3_600_000;
const CATCH_UP_MS = 10 * 60_000;      // a slot missed by up to 10 min (restart) is still posted
export const MIN_INTERVAL_S = 10;     // Telegram throttles bots posting faster than ~20 messages/min per group

export const HOURLY_SLOTS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

export const announcementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(4000),
  mode: z.enum(['times', 'interval']),
  times: z.array(z.enum(HOURLY_SLOTS)).max(24).default([]),
  intervalSeconds: z.coerce.number().int().min(MIN_INTERVAL_S, `ทุกอย่างน้อย ${MIN_INTERVAL_S} วินาที`).max(604800).nullable().default(null),
  startAt: z.string().datetime({ offset: true }).nullable().default(null),
  enabled: z.boolean().default(true),
}).superRefine((b, ctx) => {
  // Either 1.1 (time slots) or 1.2 (interval) — a request carrying both is refused, not guessed.
  if (b.times.length > 0 && (b.intervalSeconds != null || b.startAt != null)) {
    ctx.addIssue({ code: 'custom', path: ['mode'], message: 'เลือกได้อย่างใดอย่างหนึ่ง: เวลาที่กำหนด (1.1) หรือทุกช่วงเวลา (1.2) — ไม่ใช่ทั้งสองแบบ' });
    return;
  }
  if (b.mode === 'times' && b.times.length === 0) ctx.addIssue({ code: 'custom', path: ['times'], message: 'เลือกเวลาอย่างน้อย 1 ช่วง' });
  if (b.mode === 'interval' && (!b.intervalSeconds || !b.startAt)) ctx.addIssue({ code: 'custom', path: ['intervalSeconds'], message: 'ระบุช่วงเวลา และเวลาเริ่ม' });
});

// ---------- schedule ----------

/** The latest slot at or before `now` (ms), or null. */
function latestSlot(a, now) {
  if (a.mode === 'interval') {
    const start = new Date(a.start_at).getTime();
    if (now < start) return null;
    const step = a.interval_seconds * 1000;
    return start + Math.floor((now - start) / step) * step;
  }
  const local = now + TZ_OFFSET_MS;
  const dayStart = local - (local % (24 * HOUR));
  let best = null;
  for (const t of a.times) {
    const h = Number(t.slice(0, 2));
    for (const day of [dayStart, dayStart - 24 * HOUR]) {
      const slot = day + h * HOUR - TZ_OFFSET_MS;
      if (slot <= now && (best === null || slot > best)) best = slot;
    }
  }
  return best;
}

/** The next `n` slots after `now`. */
export function nextSlots(a, now = Date.now(), n = 3) {
  const out = [];
  if (a.mode === 'interval') {
    if (!a.start_at || !a.interval_seconds) return out;
    const start = new Date(a.start_at).getTime();
    const step = a.interval_seconds * 1000;
    let t = now < start ? start : start + (Math.floor((now - start) / step) + 1) * step;
    while (out.length < n) { out.push(new Date(t).toISOString()); t += step; }
    return out;
  }
  if (!a.times?.length) return out;
  const local = now + TZ_OFFSET_MS;
  const dayStart = local - (local % (24 * HOUR));
  const hours = [...a.times].map((t) => Number(t.slice(0, 2))).sort((x, y) => x - y);
  for (let d = 0; out.length < n && d < 3; d++) {
    for (const h of hours) {
      const slot = dayStart + d * 24 * HOUR + h * HOUR - TZ_OFFSET_MS;
      if (slot > now && out.length < n) out.push(new Date(slot).toISOString());
    }
  }
  return out;
}

// ---------- groups the bot is in ----------

export async function recordChat(chat, status) {
  if (!chat || chat.type === 'private') return;
  await query(
    `INSERT INTO telegram_bot_chats (bot, chat_id, title, type, status) VALUES ('support', $1, $2, $3, $4)
     ON CONFLICT (bot, chat_id) DO UPDATE SET title = coalesce(EXCLUDED.title, telegram_bot_chats.title), type = EXCLUDED.type,
       status = EXCLUDED.status, updated_at = now()`,
    [String(chat.id), chat.title ?? null, chat.type ?? null, status],
  );
}
export async function listChats() {
  const { rows } = await query(`SELECT chat_id AS "chatId", title, type, status, updated_at AS "updatedAt" FROM telegram_bot_chats WHERE bot = 'support' ORDER BY status IN ('left', 'kicked'), title`);
  return rows;
}
const activeChats = async () => (await query(`SELECT chat_id, title FROM telegram_bot_chats WHERE bot = 'support' AND status IN ('member', 'administrator', 'creator')`)).rows;

// ---------- admin CRUD ----------

const COLS = `id, title, message, mode, times, interval_seconds AS "intervalSeconds", start_at AS "startAt", enabled, updated_at AS "updatedAt", updated_by AS "updatedBy",
  (SELECT row_to_json(r) FROM (SELECT slot_at AS "slotAt", manual, sent, failed, detail, created_at AS "createdAt" FROM announcement_runs WHERE announcement_id = announcements.id ORDER BY created_at DESC LIMIT 1) r) AS "lastRun"`;
const audit = (actor, action, ref, detail) => query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'setting', $3, $4)`, [actor ?? 'console', action, ref, detail]);
const present = (a) => ({ ...a, nextRuns: nextSlots({ mode: a.mode, times: a.times, interval_seconds: a.intervalSeconds, start_at: a.startAt }) });

export async function listAnnouncements() {
  const { rows } = await query(`SELECT ${COLS} FROM announcements ORDER BY id`);
  return rows.map(present);
}
const fields = (b) => [b.title, b.message, b.mode, b.mode === 'times' ? [...new Set(b.times)].sort() : [], b.mode === 'interval' ? b.intervalSeconds : null, b.mode === 'interval' ? b.startAt : null, b.enabled];
export async function createAnnouncement(actor, b) {
  const { rows } = await query(`INSERT INTO announcements (title, message, mode, times, interval_seconds, start_at, enabled, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [...fields(b), actor]);
  await audit(actor, 'announcement.create', String(rows[0].id), `เพิ่มประชาสัมพันธ์: ${b.title}`);
  return { id: rows[0].id };
}
export async function updateAnnouncement(actor, id, b) {
  const { rowCount } = await query(`UPDATE announcements SET title = $2, message = $3, mode = $4, times = $5, interval_seconds = $6, start_at = $7, enabled = $8, updated_by = $9, updated_at = now() WHERE id = $1`, [id, ...fields(b), actor]);
  if (!rowCount) throw new NotFoundError('ไม่พบประชาสัมพันธ์นี้');
  await audit(actor, 'announcement.update', String(id), `แก้ไขประชาสัมพันธ์: ${b.title}`);
  return { success: true };
}
export async function deleteAnnouncement(actor, id) {
  const { rows } = await query('DELETE FROM announcements WHERE id = $1 RETURNING title', [id]);
  if (!rows[0]) throw new NotFoundError('ไม่พบประชาสัมพันธ์นี้');
  await audit(actor, 'announcement.delete', String(id), `ลบประชาสัมพันธ์: ${rows[0].title}`);
  return { success: true };
}

// ---------- posting ----------

async function post(a, slotAt, manual) {
  // Claim the slot first: if another run already has it, do nothing.
  const { rows: claim } = await query(`INSERT INTO announcement_runs (announcement_id, slot_at, manual) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [a.id, new Date(slotAt), manual]);
  if (!claim[0]) return null;
  const cfg = await configOf('supportBot');
  const results = [];
  for (const c of await activeChats()) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c.chat_id, text: a.message }), signal: AbortSignal.timeout(15_000),
      }).then((x) => x.json());
      results.push({ chatId: c.chat_id, title: c.title, ok: !!r.ok, error: r.ok ? null : r.description ?? 'error' });
      // Removed from the group (or it was deleted): stop posting there.
      if (!r.ok && /kicked|not a member|chat not found|bot was blocked/i.test(r.description ?? '')) await recordChat({ id: c.chat_id, title: c.title, type: 'group' }, 'left');
    } catch (err) {
      results.push({ chatId: c.chat_id, title: c.title, ok: false, error: err.message });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  await query('UPDATE announcement_runs SET sent = $2, failed = $3, detail = $4 WHERE id = $1', [claim[0].id, sent, results.length - sent, JSON.stringify(results)]);
  await audit('system', 'announcement.post', String(a.id), `โพสต์ “${a.title}” ไป ${sent}/${results.length} กลุ่ม${manual ? ' (ส่งทันที)' : ''}`);
  return { sent, failed: results.length - sent, results };
}

export async function sendNow(actor, id) {
  const { rows } = await query('SELECT * FROM announcements WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('ไม่พบประชาสัมพันธ์นี้');
  const r = await post(rows[0], Date.now(), true);
  await audit(actor, 'announcement.send_now', String(id), `กดส่งทันที: ${rows[0].title}`);
  return r ?? { sent: 0, failed: 0, results: [] };
}

/** One scheduler tick: post every enabled announcement whose latest slot is due and not yet posted. */
export async function runDue(now = Date.now()) {
  const cfg = await configOf('supportBot');
  if (!cfg.enabled || !cfg.botToken) return;
  const { rows } = await query('SELECT * FROM announcements WHERE enabled');
  for (const a of rows) {
    const slot = latestSlot(a, now);
    if (slot !== null && now - slot <= CATCH_UP_MS) await post(a, slot, false).catch((err) => logger.warn({ err: err.message, id: a.id }, 'announcement post failed'));
  }
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  const tick = () => runDue().catch((err) => logger.warn({ err: err.message }, 'announcement scheduler tick failed'));
  timer = setInterval(tick, 5_000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  logger.info('announcement scheduler started');
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }
