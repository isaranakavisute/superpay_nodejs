import { z } from 'zod';
import { tgSend } from '../shared/telegram-send.js';
import { query } from '../db/pool.js';
import { MARK_DELETED } from '../shared/soft-delete.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { internal as configOf } from '../config-admin/config.service.js';
import logger from '../logger.js';

/**
 * ประชาสัมพันธ์: messages @OptionPaySupportBot posts to every Telegram group it is in,
 * at chosen hourly slots ('times', every day or only on one date), every N seconds/minutes/hours
 * from a start ('interval'), or once right when it is saved ('now'), Bangkok time. The scheduler checks every 5 seconds; each slot is claimed in announcement_runs first, so it
 * is posted once even across restarts or two servers.
 */
const TZ_OFFSET_MS = 7 * 3_600_000;   // Asia/Bangkok (no DST)
const HOUR = 3_600_000;
const CATCH_UP_MS = 10 * 60_000;      // a slot missed by up to 10 min (restart) is still posted
export const MIN_INTERVAL_S = 10;     // Telegram throttles bots posting faster than ~20 messages/min per group

// Telegram Bot API limits: photo upload ≤ 10 MB, any upload ≤ 50 MB per request (an album's first send uploads all its
// files in one request), caption ≤ 1024 characters, album 2–10 items.
export const MAX_ALBUM = 10;
const PHOTO_MAX = 10 << 20;
const VIDEO_MAX = 50 << 20;
const UPLOAD_MAX = 50 << 20;
const CAPTION_MAX = 1024;
const UPLOAD_TIMEOUT_MS = 180_000;
const MEDIA_TYPES = { 'image/jpeg': 'photo', 'image/png': 'photo', 'image/webp': 'photo', 'video/mp4': 'video' };

export const HOURLY_SLOTS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

export const announcementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  // Text; may be empty when the post has a picture / video / album (then it is the caption, or nothing).
  message: z.string().trim().max(4000).default(''),
  // Uploaded files (POST /announcements/media) in posting order: 1 = picture or video, 2–10 = album.
  mediaIds: z.array(z.coerce.number().int().positive()).max(MAX_ALBUM, `อัลบั้มได้สูงสุด ${MAX_ALBUM} ไฟล์`).default([]),
  pin: z.boolean().default(false),
  mode: z.enum(['times', 'interval', 'now']),
  times: z.array(z.enum(HOURLY_SLOTS)).max(24).default([]),
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),   // 1.1 only: null = every day
  intervalSeconds: z.coerce.number().int().min(MIN_INTERVAL_S, `ทุกอย่างน้อย ${MIN_INTERVAL_S} วินาที`).max(604800).nullable().default(null),
  startAt: z.string().datetime({ offset: true }).nullable().default(null),
  enabled: z.boolean().default(true),
}).superRefine((b, ctx) => {
  if (!b.message && b.mediaIds.length === 0) ctx.addIssue({ code: 'custom', path: ['message'], message: 'ใส่ข้อความ หรือแนบรูป / วิดีโออย่างน้อย 1 ไฟล์' });
  // Only one of 1.1 (time slots), 1.2 (interval), 1.3 (once now) — a request carrying two is refused, not guessed.
  const used = [b.times.length > 0 || b.onDate != null, b.intervalSeconds != null || b.startAt != null].filter(Boolean).length;
  if (used > 1 || (b.mode === 'now' && used > 0)) {
    ctx.addIssue({ code: 'custom', path: ['mode'], message: 'เลือกได้อย่างใดอย่างหนึ่ง: 1.1 ตามเวลาที่เลือก, 1.2 ทุกช่วงเวลา หรือ 1.3 ส่งครั้งเดียวทันที' });
    return;
  }
  if (b.mode === 'times' && b.times.length === 0) ctx.addIssue({ code: 'custom', path: ['times'], message: 'เลือกเวลาอย่างน้อย 1 ช่วง' });
  if (b.mode === 'interval' && (!b.intervalSeconds || !b.startAt)) ctx.addIssue({ code: 'custom', path: ['intervalSeconds'], message: 'ระบุช่วงเวลา และเวลาเริ่ม' });
});

// ---------- schedule ----------

/** Bangkok date (YYYY-MM-DD) of a Bangkok-midnight in local ms. */
const dayOf = (localMs) => new Date(localMs).toISOString().slice(0, 10);

/** The latest slot at or before `now` (ms), or null. */
function latestSlot(a, now) {
  if (a.mode === 'now') return null;
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
      if (a.on_day && dayOf(day) !== a.on_day) continue;
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
      if (a.on_day && dayOf(dayStart + d * 24 * HOUR) !== a.on_day) continue;
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

// ---------- media (pictures / videos) ----------

const looksLike = (mime, b) => (mime === 'image/jpeg' ? b[0] === 0xff && b[1] === 0xd8
  : mime === 'image/png' ? b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : mime === 'image/webp' ? b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
      : b.toString('latin1', 4, 8) === 'ftyp');   // mp4

/** Stores one uploaded file (raw bytes). The announcement links it when saved. */
export async function uploadMedia(actor, { mime, name, data }) {
  const kind = MEDIA_TYPES[String(mime).toLowerCase()];
  if (!kind) throw new BadRequestError('รองรับเฉพาะรูป JPG / PNG / WEBP และวิดีโอ MP4');
  if (!Buffer.isBuffer(data) || data.length < 100) throw new BadRequestError('ไฟล์ว่างหรือเสีย');
  if (!looksLike(mime, data)) throw new BadRequestError('เนื้อไฟล์ไม่ตรงกับชนิดไฟล์');
  if (kind === 'photo' && data.length > PHOTO_MAX) throw new BadRequestError('รูปต้องไม่เกิน 10 MB (ข้อจำกัดของ Telegram)');
  if (kind === 'video' && data.length > VIDEO_MAX) throw new BadRequestError('วิดีโอต้องไม่เกิน 50 MB (ข้อจำกัดของ Telegram)');
  const clean = String(name ?? '').replace(/[\u0000-\u001f/\\]/g, '').slice(0, 120) || `${kind}.${mime.split('/')[1]}`;
  const { rows } = await query(
    `INSERT INTO announcement_media (kind, mime, name, bytes, data, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, mime, name, bytes`,
    [kind, mime, clean, data.length, data, actor ?? 'console'],
  );
  return { media: rows[0] };
}
export async function getMedia(id) {
  const { rows } = await query('SELECT mime, data FROM announcement_media WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('ไม่พบไฟล์');
  return rows[0];
}
/** The files of an announcement, checked: all exist, an album's first upload fits Telegram's 50 MB request limit. */
async function checkMedia(ids) {
  if (!ids.length) return [];
  if (new Set(ids).size !== ids.length) throw new BadRequestError('มีไฟล์ซ้ำในรายการ');
  const { rows } = await query('SELECT id, kind, bytes FROM announcement_media WHERE id = ANY ($1::bigint[])', [ids]);
  if (rows.length !== ids.length) throw new BadRequestError('ไม่พบไฟล์ที่แนบบางไฟล์ — อัปโหลดใหม่');
  if (ids.length > 1 && rows.reduce((t, r) => t + r.bytes, 0) > UPLOAD_MAX) throw new BadRequestError('อัลบั้มรวมกันต้องไม่เกิน 50 MB (ข้อจำกัดของ Telegram)');
  return rows;
}

// ---------- admin CRUD ----------

const COLS = `id, title, message, mode, times, media_ids::int[] AS "mediaIds", pin,
  (SELECT coalesce(json_agg(json_build_object('id', m.id, 'kind', m.kind, 'name', m.name, 'bytes', m.bytes) ORDER BY array_position(announcements.media_ids, m.id)), '[]')
     FROM announcement_media m WHERE m.id = ANY (announcements.media_ids)) AS media, to_char(on_date, 'YYYY-MM-DD') AS "onDate", interval_seconds AS "intervalSeconds", start_at AS "startAt", enabled, updated_at AS "updatedAt", updated_by AS "updatedBy",
  (SELECT row_to_json(r) FROM (SELECT slot_at AS "slotAt", manual, sent, failed, detail, created_at AS "createdAt" FROM announcement_runs WHERE announcement_id = announcements.id ORDER BY created_at DESC LIMIT 1) r) AS "lastRun"`;
const audit = (actor, action, ref, detail) => query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'setting', $3, $4)`, [actor ?? 'console', action, ref, detail]);
const present = (a) => ({ ...a, nextRuns: nextSlots({ mode: a.mode, times: a.times, on_day: a.onDate, interval_seconds: a.intervalSeconds, start_at: a.startAt }) });

/** Can scheduled posts go out? (shown on the ประชาสัมพันธ์ page) */
export async function postingStatus() {
  const cfg = await configOf('supportBot');
  return { canPost: !!cfg.botToken, faqEnabled: !!cfg.enabled };
}

export async function listAnnouncements() {
  const { rows } = await query(`SELECT ${COLS} FROM announcements WHERE deleted_at IS NULL ORDER BY id`);
  return rows.map(present);
}
const fields = (b) => [b.title, b.message, b.mode, b.mode === 'times' ? [...new Set(b.times)].sort() : [], b.mode === 'interval' ? b.intervalSeconds : null,
  b.mode === 'interval' ? b.startAt : null, b.mode === 'now' || b.enabled, b.mode === 'times' ? b.onDate : null, b.mediaIds, b.pin];
const what = (b) => [b.mediaIds.length === 1 ? '1 ไฟล์' : b.mediaIds.length > 1 ? `อัลบั้ม ${b.mediaIds.length} ไฟล์` : null, b.pin ? 'ปักหมุด' : null].filter(Boolean).join(' · ');

/** 1.3: saving a 'now' announcement posts it once, right away (each save posts again). */
async function postIfNow(id, b) {
  if (b.mode !== 'now') return {};
  return (await post({ id, title: b.title, message: b.message, media_ids: b.mediaIds, pin: b.pin }, Date.now(), true)) ?? { sent: 0, failed: 0, results: [] };
}

export async function createAnnouncement(actor, b) {
  await checkMedia(b.mediaIds);
  const { rows } = await query(`INSERT INTO announcements (title, message, mode, times, interval_seconds, start_at, enabled, on_date, media_ids, pin, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [...fields(b), actor]);
  await audit(actor, 'announcement.create', String(rows[0].id), `เพิ่มประชาสัมพันธ์: ${b.title}${what(b) ? ` (${what(b)})` : ''}`);
  return { id: rows[0].id, ...(await postIfNow(rows[0].id, b)) };
}
export async function updateAnnouncement(actor, id, b) {
  await checkMedia(b.mediaIds);
  const { rowCount } = await query(`UPDATE announcements SET title = $2, message = $3, mode = $4, times = $5, interval_seconds = $6, start_at = $7, enabled = $8, on_date = $9, media_ids = $10, pin = $11, updated_by = $12, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id, ...fields(b), actor]);
  if (!rowCount) throw new NotFoundError('ไม่พบประชาสัมพันธ์นี้');
  await audit(actor, 'announcement.update', String(id), `แก้ไขประชาสัมพันธ์: ${b.title}${what(b) ? ` (${what(b)})` : ''}`);
  return { success: true, ...(await postIfNow(id, b)) };
}
/** "ลบ" keeps the announcement (soft delete, 18 Oct 2026): switched off and hidden; รายการที่ลบแล้ว shows / restores it. */
export async function deleteAnnouncement(actor, id, reason) {
  const { rows } = await query(`UPDATE announcements SET enabled = false, ${MARK_DELETED} WHERE id = $1 AND deleted_at IS NULL RETURNING title`, [id, actor ?? 'console', reason]);
  if (!rows[0]) throw new NotFoundError('ไม่พบประชาสัมพันธ์นี้');
  await audit(actor, 'announcement.delete', String(id), `ลบประชาสัมพันธ์: ${rows[0].title} — ${reason} (เก็บข้อมูลไว้ · กู้คืนได้ที่รายการที่ลบแล้ว)`);
  return { success: true };
}

// ---------- posting ----------

async function post(a, slotAt, manual) {
  // Claim the slot first: if another run already has it, do nothing.
  const { rows: claim } = await query(`INSERT INTO announcement_runs (announcement_id, slot_at, manual) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [a.id, new Date(slotAt), manual]);
  if (!claim[0]) return null;
  const cfg = await configOf('supportBot');
  const media = await mediaOf(a.media_ids ?? []);
  const prevPins = a.pin ? await lastPins(a.id, claim[0].id) : new Map();
  const results = [];
  for (const c of await activeChats()) {
    try {
      const r = await postToChat(cfg.botToken, c.chat_id, a.message ?? '', media, !!a.pin, prevPins.get(String(c.chat_id)));
      results.push({ chatId: c.chat_id, title: c.title, ok: !!r.ok, error: r.ok ? null : r.description ?? 'error',
        ...(a.pin ? { pinned: !!r.pinned, pinError: r.pinError ?? null, pinnedMessageId: r.pinned ? r.messageId : null } : {}) });
      // Removed from the group (or it was deleted): stop posting there.
      if (!r.ok && /kicked|not a member|chat not found|bot was blocked/i.test(r.description ?? '')) await recordChat({ id: c.chat_id, title: c.title, type: 'group' }, 'left');
    } catch (err) {
      results.push({ chatId: c.chat_id, title: c.title, ok: false, error: err.message });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  const pinFailed = a.pin ? results.filter((r) => r.ok && !r.pinned).length : 0;
  await query('UPDATE announcement_runs SET sent = $2, failed = $3, detail = $4 WHERE id = $1', [claim[0].id, sent, results.length - sent, JSON.stringify(results)]);
  await audit('system', 'announcement.post', String(a.id), `โพสต์ “${a.title}” ไป ${sent}/${results.length} กลุ่ม${media.length ? ` (${media.length === 1 ? (media[0].kind === 'photo' ? 'รูป' : 'วิดีโอ') : `อัลบั้ม ${media.length} ไฟล์`})` : ''}${a.pin ? ` · ปักหมุด ${sent - pinFailed}/${sent}` : ''}${manual ? ' (1.3 ส่งทันที)' : ''}`);
  return { sent, failed: results.length - sent, results };
}

// ---------- sending text / picture / video / album (+ pin) ----------

/** Per group, the message this announcement pinned last time (from earlier runs) — unpinned when a new post is pinned. */
async function lastPins(announcementId, currentRunId) {
  const { rows } = await query(
    `SELECT detail FROM announcement_runs WHERE announcement_id = $1 AND id <> $2 AND detail IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
    [announcementId, currentRunId],
  );
  const out = new Map();
  for (const r of rows) for (const d of (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) ?? []) {
    if (d?.pinnedMessageId && !out.has(String(d.chatId))) out.set(String(d.chatId), d.pinnedMessageId);
  }
  return out;
}

/** Files of a post in order (without the bytes — those are read only when an upload is needed). */
async function mediaOf(ids) {
  if (!ids.length) return [];
  const { rows } = await query('SELECT id, kind, mime, name, tg_file_id FROM announcement_media WHERE id = ANY ($1::bigint[])', [ids.map(Number)]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.map((id) => byId.get(Number(id))).filter(Boolean);
}
const bytesOf = async (m) => (await query('SELECT data FROM announcement_media WHERE id = $1', [m.id])).rows[0].data;
const fileIdOf = (msg) => (msg?.photo ? msg.photo.at(-1)?.file_id : msg?.video?.file_id) ?? null;
const saveFileId = (m, fileId) => { m.tg_file_id = fileId; return query('UPDATE announcement_media SET tg_file_id = $2 WHERE id = $1', [m.id, fileId]); };
const staleFileId = (r) => !r.ok && /file identifier|wrong file|file_id|failed to get http url content|wrong remote file/i.test(r.description ?? '');

/** One picture / video: by Telegram file id when known, else upload (and remember the id). */
async function sendOne(token, chatId, m, caption) {
  const method = m.kind === 'photo' ? 'sendPhoto' : 'sendVideo';
  const extra = { ...(caption ? { caption } : {}), ...(m.kind === 'video' ? { supports_streaming: true } : {}) };
  if (m.tg_file_id) {
    const r = await tgSend(token, method, { chat_id: chatId, [m.kind]: m.tg_file_id, ...extra });
    if (!staleFileId(r)) return r;
    m.tg_file_id = null;
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  form.append(m.kind, new Blob([await bytesOf(m)], { type: m.mime }), m.name ?? m.kind);
  const r = await tgSend(token, method, form, { timeoutMs: UPLOAD_TIMEOUT_MS });
  if (r.ok && fileIdOf(r.result)) await saveFileId(m, fileIdOf(r.result));
  return r;
}

/** An album (2–10): files without a Telegram id yet are uploaded in the same request (attach://). */
async function sendAlbum(token, chatId, media, caption, retry = true) {
  const items = media.map((m, i) => ({ type: m.kind, media: m.tg_file_id ?? `attach://f${i}`, ...(i === 0 && caption ? { caption } : {}), ...(m.kind === 'video' ? { supports_streaming: true } : {}) }));
  let r;
  if (media.every((m) => m.tg_file_id)) r = await tgSend(token, 'sendMediaGroup', { chat_id: chatId, media: items });
  else {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('media', JSON.stringify(items));
    for (const [i, m] of media.entries()) if (!m.tg_file_id) form.append(`f${i}`, new Blob([await bytesOf(m)], { type: m.mime }), m.name ?? m.kind);
    r = await tgSend(token, 'sendMediaGroup', form, { timeoutMs: UPLOAD_TIMEOUT_MS });
  }
  if (staleFileId(r) && retry) { for (const m of media) m.tg_file_id = null; return sendAlbum(token, chatId, media, caption, false); }
  if (r.ok && Array.isArray(r.result)) for (const [i, msg] of r.result.entries()) if (media[i] && !media[i].tg_file_id && fileIdOf(msg)) await saveFileId(media[i], fileIdOf(msg));
  return r;
}

/**
 * Posts one announcement to one group: text, picture, video or album (text as caption when it fits Telegram's
 * 1024 characters, else as a message right after), then pins it if asked (album: its first item). Returns
 * { ok, description?, pinned?, pinError? } — a failed pin does not make the post fail.
 */
export async function postToChat(token, chatId, text, media, pin, unpinMessageId = null) {
  const caption = text && text.length <= CAPTION_MAX ? text : null;
  let r;
  if (!media.length) r = await tgSend(token, 'sendMessage', { chat_id: chatId, text });
  else {
    r = media.length === 1 ? await sendOne(token, chatId, media[0], caption) : await sendAlbum(token, chatId, media, caption);
    if (r.ok && text && !caption) {
      const t = await tgSend(token, 'sendMessage', { chat_id: chatId, text });
      if (!t.ok) return { ok: false, description: `ส่งรูป/วิดีโอแล้ว แต่ส่งข้อความต่อท้ายไม่ได้: ${t.description ?? 'error'}` };
    }
  }
  if (!r.ok || !pin) return r;
  const messageId = Array.isArray(r.result) ? r.result[0]?.message_id : r.result?.message_id;
  const p = await tgSend(token, 'pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
  // A repeat replaces this announcement's own previous pin (other pins in the group are left alone). Already gone: ignored.
  if (p.ok && unpinMessageId && unpinMessageId !== messageId) await tgSend(token, 'unpinChatMessage', { chat_id: chatId, message_id: unpinMessageId }).catch(() => null);
  return { ...r, messageId, pinned: !!p.ok, pinError: p.ok ? null : p.description ?? 'ปักหมุดไม่ได้' };
}

/** One scheduler tick: post every enabled announcement whose latest slot is due and not yet posted. */
export async function runDue(now = Date.now()) {
  // Posting needs only the bot token: switching off บอทตอบคำถาม (FAQ answers) does not stop ประชาสัมพันธ์.
  const cfg = await configOf('supportBot');
  if (!cfg.botToken) return;
  const { rows } = await query(`SELECT *, to_char(on_date, 'YYYY-MM-DD') AS on_day FROM announcements WHERE enabled AND deleted_at IS NULL AND mode <> 'now'`);
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
