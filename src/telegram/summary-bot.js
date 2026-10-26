import { query } from '../db/pool.js';
import logger from '../logger.js';
import { open } from '../shared/secret-box.js';
import { tgSend } from '../shared/telegram-send.js';
import { visible } from '../shared/private-records.js';

/**
 * @OptionPayTransactionBot — "สรุปยอด" in the Telegram group "Option Pay สรุปยอด" (user, 25 Oct 2026): today's paid
 * payments and completed payouts (count + sum) per shop, parent shops with their child shops as a tree, from midnight
 * (Bangkok) to the moment it is asked. Polls getUpdates (no webhook URL needed); answers in that one group only — the
 * chat id is locked on the first message from a group with that title (console_config 'summaryBot').
 * Config: console_config section 'summaryBot' = { token: sealed bot token, title, chatId }.
 */
const SECTION = 'summaryBot';
const TRIGGERS = new Set(['สรุปยอด', '/สรุปยอด', '/summary']);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const baht = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => Number(n).toLocaleString('th-TH');

async function loadConfig() {
  const { rows } = await query('SELECT value FROM console_config WHERE section = $1', [SECTION]);
  const v = rows[0]?.value;
  return v?.token ? { ...v, token: open(v.token) } : null;
}

const lockChat = (chatId) =>
  query(`UPDATE console_config SET value = value || jsonb_build_object('chatId', $1::bigint), updated_at = now() WHERE section = $2`, [chatId, SECTION]);

/** Today's (Bangkok) paid payments and completed payouts per shop, until now. */
export async function todaySummary() {
  const { rows: [{ since, now }] } = await query(
    `SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok') AS since, now() AS now`);
  const [{ rows: shops }, { rows: pay }, { rows: out }] = await Promise.all([
    query(`SELECT id, name, parent_id FROM merchants WHERE deleted_at IS NULL ORDER BY name`),
    query(`SELECT merchant_id, count(*)::int AS n, coalesce(sum(amount), 0) AS sum FROM payments p
            WHERE status = 'approved' AND deleted_at IS NULL AND completed_at >= $1 AND completed_at <= $2 AND ${visible('payment', 'p.ref', null)}
            GROUP BY merchant_id`, [since, now]),
    query(`SELECT merchant_id, count(*)::int AS n, coalesce(sum(amount), 0) AS sum FROM outflows o
            WHERE status = 'approved' AND deleted_at IS NULL AND completed_at >= $1 AND completed_at <= $2 AND ${visible('outflow', 'o.ref', null)}
            GROUP BY merchant_id`, [since, now]),
  ]);
  const P = new Map(pay.map((r) => [r.merchant_id, r]));
  const O = new Map(out.map((r) => [r.merchant_id, r]));
  const node = (s) => ({ ...s, pn: P.get(s.id)?.n ?? 0, ps: Number(P.get(s.id)?.sum ?? 0), on: O.get(s.id)?.n ?? 0, os: Number(O.get(s.id)?.sum ?? 0), kids: [] });
  const byId = new Map(shops.map((s) => [s.id, node(s)]));
  const roots = [];
  for (const s of byId.values()) (s.parent_id && byId.has(s.parent_id) ? byId.get(s.parent_id).kids : roots).push(s);
  const total = (s) => s.kids.reduce((t, k) => { const x = total(k); return { pn: t.pn + x.pn, ps: t.ps + x.ps, on: t.on + x.on, os: t.os + x.os }; },
    { pn: s.pn, ps: s.ps, on: s.on, os: s.os });
  return { since, now, roots, total };
}

/** The reply: one block per shop, child shops indented under their parent, a line per parent's whole branch, then the grand total. */
export function formatSummary({ since, now, roots, total }) {
  const day = new Date(now).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric' });
  const hm = (d) => new Date(d).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const W = 14;   // width of the amount column
  const lines = [];
  const row = (pre, label, n, sum) => `${pre}${label} ${String(int(n)).padStart(5)} รายการ ${('฿' + baht(sum)).padStart(W)}`;
  const shop = (s, pre, last, depth) => {
    const branch = depth === 0 ? '' : last ? '└─ ' : '├─ ';
    const inner = depth === 0 ? '   ' : `${pre}${last ? '   ' : '│  '}`;
    lines.push(`${depth === 0 ? '🏪 ' : pre + branch}${s.name}`);
    lines.push(row(inner, 'ฝาก', s.pn, s.ps));
    lines.push(row(inner, 'ถอน', s.on, s.os));
    s.kids.forEach((k, i) => shop(k, inner, i === s.kids.length - 1, depth + 1));
    if (depth === 0 && s.kids.length) {
      const t = total(s);
      lines.push(`   ── รวมทั้งสาย ${s.name} ──`);
      lines.push(row('   ', 'ฝาก', t.pn, t.ps));
      lines.push(row('   ', 'ถอน', t.on, t.os));
    }
    if (depth === 0) lines.push('');
  };
  roots.forEach((r) => shop(r, '', true, 0));
  const all = roots.map(total).reduce((a, t) => ({ pn: a.pn + t.pn, ps: a.ps + t.ps, on: a.on + t.on, os: a.os + t.os }), { pn: 0, ps: 0, on: 0, os: 0 });
  const head = `<b>📊 สรุปยอดประจำวันที่ ${esc(day)}</b>\nช่วงเวลา 00:00 – ${hm(now)} น. · ฝาก = ชำระเงินสำเร็จ · ถอน = โอนออกสำเร็จ`;
  const foot = `<b>รวมทุกร้าน</b>\n<pre>${esc(row('', 'ฝาก', all.pn, all.ps))}\n${esc(row('', 'ถอน', all.on, all.os))}</pre>`;
  // Telegram allows 4096 characters per message: split the shop blocks across messages.
  const blocks = lines.join('\n').split('\n\n').filter((b) => b.trim());
  const msgs = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (cur.length + b.length) > 3300) { msgs.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + b;
  }
  if (cur) msgs.push(cur);
  return [head, ...msgs.map((m) => `<pre>${esc(m)}</pre>`), foot];
}

let stop = false;
let offset = 0;

async function handle(cfg, msg) {
  const chat = msg.chat ?? {};
  const text = String(msg.text ?? '').trim().replace(/@\w+$/, '');
  if (!TRIGGERS.has(text) || chat.type === 'private') return;
  if (cfg.chatId ? Number(cfg.chatId) !== Number(chat.id) : chat.title !== cfg.title) return;
  if (!cfg.chatId) { await lockChat(chat.id); cfg.chatId = chat.id; logger.info({ chatId: chat.id }, 'summary bot: group locked'); }
  try {
    const parts = formatSummary(await todaySummary());
    for (const p of parts) await tgSend(cfg.token, 'sendMessage', { chat_id: chat.id, text: p, parse_mode: 'HTML', disable_web_page_preview: true });
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('telegram', 'summary.sent', 'telegram', $1, $2)`,
      [String(chat.id), `ส่งสรุปยอดประจำวันให้กลุ่ม ${chat.title ?? ''} (ขอโดย ${msg.from?.username ?? msg.from?.first_name ?? '-'})`]).catch(() => {});
  } catch (err) {
    logger.warn({ err }, 'summary bot: reply failed');
    await tgSend(cfg.token, 'sendMessage', { chat_id: chat.id, text: 'ขออภัย สรุปยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }).catch(() => {});
  }
}

async function loop() {
  while (!stop) {
    let cfg = null;
    try {
      cfg = await loadConfig();
      if (!cfg) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
      const r = await fetch(`https://api.telegram.org/bot${cfg.token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`,
        { signal: AbortSignal.timeout(35_000) });
      const j = await r.json();
      if (!j.ok) { logger.warn({ description: j.description }, 'summary bot: getUpdates failed'); await new Promise((res) => setTimeout(res, 10_000)); continue; }
      for (const u of j.result) {
        offset = u.update_id + 1;
        if (u.message) await handle(cfg, u.message);
      }
    } catch (err) {
      if (!stop) { logger.warn({ err }, 'summary bot: poll error'); await new Promise((res) => setTimeout(res, 5_000)); }
    }
  }
}

/** Production only (local dev shares the database and the bot: two pollers would steal each other's updates). */
export function startSummaryBot() {
  stop = false;
  loop();
}
export function stopSummaryBot() { stop = true; }
