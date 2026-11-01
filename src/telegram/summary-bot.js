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
 * Follow-up question (user, 31 Oct 2026): "สรุปยอด" first asks 1. รายวัน (today so far) or 2. รายเดือน (this month so far),
 * as buttons; replying 1 / 2 to the question, or typing "สรุปยอด รายวัน" / "สรุปยอด รายเดือน", answers it directly.
 * 3. เดือนที่ผ่านมา (user, 1 Nov 2026): the whole previous month, 1st 00:00 to its last day 23:59 (Bangkok).
 * Typed answer (user, 1 Nov 2026): a plain "1" / "2" / "3" (or รายวัน / รายเดือน / เดือนที่ผ่านมา) in the group answers the
 * bot's open question there (latest one, at most QUESTION_TTL_S old) — no need to reply to the question or press a button.
 */
const SECTION = 'summaryBot';
const TRIGGERS = new Set(['สรุปยอด', '/สรุปยอด', '/summary']);
const QUESTION = '📊 ต้องการสรุปยอดแบบใด?\n1. รายวัน (วันนี้ ตั้งแต่ 00:00 ถึงตอนนี้)\n2. รายเดือน (เดือนนี้ ตั้งแต่วันที่ 1 ถึงตอนนี้)\n3. เดือนที่ผ่านมา (ทั้งเดือน)';
const PERIOD_NAME = { day: 'รายวัน', month: 'รายเดือน', lastmonth: 'เดือนที่ผ่านมา' };
const CHOICE = { day: '1. รายวัน', month: '2. รายเดือน', lastmonth: '3. เดือนที่ผ่านมา' };
const QUESTION_TTL_S = 30 * 60;   // buttons older than this are refused: ask again
/** "1" / "รายวัน" → 'day'; "2" / "รายเดือน" → 'month'; "3" / "เดือนที่ผ่านมา" → 'lastmonth'; anything else → null. */
const periodOf = (t) => (/^(1|1\.|รายวัน|วัน|day|daily)$/i.test(t) ? 'day'
  : /^(2|2\.|รายเดือน|เดือน|month|monthly)$/i.test(t) ? 'month'
  : /^(3|3\.|เดือนที่ผ่านมา|เดือนที่แล้ว|เดือนก่อน|last ?month)$/i.test(t) ? 'lastmonth' : null);
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

/** Paid payments and completed payouts per shop: today / this month (Bangkok) until now, or the whole previous month. */
export async function periodSummary(period = 'day') {
  const unit = ['month', 'lastmonth'].includes(period) ? period : 'day';
  // `now` = the end of the period: the moment asked, or (previous month) the first instant of this month.
  const { rows: [{ since, now }] } = await query(
    `SELECT (date_trunc($1, now() AT TIME ZONE 'Asia/Bangkok') - CASE WHEN $2 THEN interval '1 month' ELSE interval '0' END) AT TIME ZONE 'Asia/Bangkok' AS since,
            CASE WHEN $2 THEN date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok' ELSE now() END AS now`,
    [unit === 'day' ? 'day' : 'month', unit === 'lastmonth']);
  const [{ rows: shops }, { rows: pay }, { rows: out }] = await Promise.all([
    query(`SELECT id, name, parent_id FROM merchants WHERE deleted_at IS NULL ORDER BY name`),
    query(`SELECT merchant_id, count(*)::int AS n, coalesce(sum(amount), 0) AS sum FROM payments p
            WHERE status = 'approved' AND deleted_at IS NULL AND completed_at >= $1 AND completed_at < $2 AND ${visible('payment', 'p.ref', null)}
            GROUP BY merchant_id`, [since, now]),
    query(`SELECT merchant_id, count(*)::int AS n, coalesce(sum(amount), 0) AS sum FROM outflows o
            WHERE status = 'approved' AND deleted_at IS NULL AND completed_at >= $1 AND completed_at < $2 AND ${visible('outflow', 'o.ref', null)}
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
  return { period: unit, since, now, roots, total };
}
export const todaySummary = () => periodSummary('day');

/** The reply: one block per shop, child shops indented under their parent, a line per parent's whole branch, then the grand total. */
export function formatSummary({ period = 'day', since, now, roots, total }) {
  const day = new Date(now).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric' });
  const month = new Date(period === 'lastmonth' ? since : now).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', month: 'long', year: 'numeric' });
  const dm = (d) => new Date(d).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
  const hm = (d) => new Date(d).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const [NW, W] = period === 'day' ? [5, 14] : [6, 16];   // width of the count and amount columns (a month runs into tens of millions)
  const lines = [];
  const row = (pre, label, n, sum) => `${pre}${label} ${String(int(n)).padStart(NW)} รายการ ${('฿' + baht(sum)).padStart(W)}`;
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
  const lastDay = new Date(new Date(now).getTime() - 1);   // previous month: its last day (the period ends at the 1st 00:00)
  const head = period === 'lastmonth'
    ? `<b>📊 สรุปยอดเดือนที่ผ่านมา: ${esc(month)}</b>\nช่วงเวลา ${esc(dm(since))} 00:00 – ${esc(dm(lastDay))} 23:59 น. (ทั้งเดือน) · ฝาก = ชำระเงินสำเร็จ · ถอน = โอนออกสำเร็จ`
    : period === 'month'
    ? `<b>📊 สรุปยอดประจำเดือน ${esc(month)}</b>\nช่วงเวลา ${esc(dm(since))} 00:00 – ${esc(dm(now))} ${hm(now)} น. · ฝาก = ชำระเงินสำเร็จ · ถอน = โอนออกสำเร็จ`
    : `<b>📊 สรุปยอดประจำวันที่ ${esc(day)}</b>\nช่วงเวลา 00:00 – ${hm(now)} น. · ฝาก = ชำระเงินสำเร็จ · ถอน = โอนออกสำเร็จ`;
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

const who = (from) => from?.username ?? from?.first_name ?? '-';
const inGroup = (cfg, chat) => (cfg.chatId ? Number(cfg.chatId) === Number(chat.id) : chat.title === cfg.title);

/** Sends the chosen summary to the group. */
async function sendSummary(cfg, chat, period, from) {
  try {
    const parts = formatSummary(await periodSummary(period));
    for (const p of parts) await tgSend(cfg.token, 'sendMessage', { chat_id: chat.id, text: p, parse_mode: 'HTML', disable_web_page_preview: true });
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('telegram', 'summary.sent', 'telegram', $1, $2)`,
      [String(chat.id), `ส่งสรุปยอด${PERIOD_NAME[period]}ให้กลุ่ม ${chat.title ?? ''} (ขอโดย ${who(from)})`]).catch(() => {});
  } catch (err) {
    logger.warn({ err, period }, 'summary bot: reply failed');
    await tgSend(cfg.token, 'sendMessage', { chat_id: chat.id, text: 'ขออภัย สรุปยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }).catch(() => {});
  }
}

const openQuestion = new Map();   // chat id → { id: question message id, at: ms } — the question a typed answer belongs to

/** Close a question: its buttons go, the text says what was chosen and by whom (one summary per question). */
async function closeQuestion(cfg, chatId, messageId, period, from) {
  answered.add(`${chatId}:${messageId}`);
  if (answered.size > 500) answered.delete(answered.values().next().value);
  if (openQuestion.get(String(chatId))?.id === messageId) openQuestion.delete(String(chatId));
  await tgSend(cfg.token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: `📊 สรุปยอด: ${CHOICE[period]} (เลือกโดย ${who(from)})` }).catch(() => {});
}

async function handle(cfg, msg) {
  const chat = msg.chat ?? {};
  const text = String(msg.text ?? '').trim().replace(/@\w+$/, '').replace(/\s+/g, ' ');
  if (chat.type === 'private' || !text) return;
  // "สรุปยอด", "สรุปยอด รายวัน", "สรุปยอดรายเดือน", "/summary 2" …
  const m = text.match(/^(\/?สรุปยอด|\/summary)(?:@\w+)? ?(.*)$/i);
  // or an answer ("1" / "2" / "3" / "รายวัน" …) to the bot's question: as a reply to it, or simply typed in the group
  const reply = msg.reply_to_message;
  const toQuestion = reply?.from?.is_bot && String(reply.text ?? '').startsWith(QUESTION.split('\n')[0]) ? reply.message_id : null;
  const open = openQuestion.get(String(chat.id));
  const asked = toQuestion ?? (!reply && open && Date.now() - open.at <= QUESTION_TTL_S * 1000 ? open.id : null);
  const answer = !m && asked && !answered.has(`${chat.id}:${asked}`) ? periodOf(text) : null;
  if (!m && !answer) return;
  if (m && (!TRIGGERS.has(m[1].toLowerCase()) || (m[2] && !periodOf(m[2].trim())))) return;   // "สรุปยอดอื่นๆ": not for the bot
  if (!inGroup(cfg, chat)) return;
  if (!cfg.chatId) { await lockChat(chat.id); cfg.chatId = chat.id; logger.info({ chatId: chat.id }, 'summary bot: group locked'); }
  const period = answer ?? (m[2] ? periodOf(m[2].trim()) : null);
  if (answer) await closeQuestion(cfg, chat.id, asked, period, msg.from);
  if (period) return sendSummary(cfg, chat, period, msg.from);
  const q = await tgSend(cfg.token, 'sendMessage', {
    chat_id: chat.id, text: QUESTION, reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
    reply_markup: { inline_keyboard: [[{ text: CHOICE.day, callback_data: 'sum:day' }, { text: CHOICE.month, callback_data: 'sum:month' }], [{ text: CHOICE.lastmonth, callback_data: 'sum:lastmonth' }]] },
  }).catch((err) => logger.warn({ err }, 'summary bot: question failed'));
  if (q?.ok) openQuestion.set(String(chat.id), { id: q.result.message_id, at: Date.now() });
}

const answered = new Set();   // question messages already answered (one summary per question, even on a double tap)

/** A tap on 1. รายวัน / 2. รายเดือน under the question. */
async function handleButton(cfg, cb) {
  const msg = cb.message ?? {};
  const chat = msg.chat ?? {};
  const period = { 'sum:day': 'day', 'sum:month': 'month', 'sum:lastmonth': 'lastmonth' }[cb.data];
  const ack = (text) => tgSend(cfg.token, 'answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!period || !msg.message_id || !cfg.chatId || Number(cfg.chatId) !== Number(chat.id)) return ack();
  const key = `${chat.id}:${msg.message_id}`;
  const close = (text) => tgSend(cfg.token, 'editMessageText', { chat_id: chat.id, message_id: msg.message_id, text }).catch(() => {});
  if (answered.has(key)) return ack('ส่งสรุปยอดของคำถามนี้แล้ว');
  if (Date.now() / 1000 - (msg.date ?? 0) > QUESTION_TTL_S) {
    answered.add(key);
    await close('📊 คำถามนี้หมดอายุแล้ว — พิมพ์ สรุปยอด ใหม่อีกครั้ง');
    return ack('คำถามนี้หมดอายุแล้ว กรุณาพิมพ์ สรุปยอด ใหม่');
  }
  await ack(`กำลังสรุปยอด${PERIOD_NAME[period]}…`);
  await closeQuestion(cfg, chat.id, msg.message_id, period, cb.from);
  await sendSummary(cfg, chat, period, cb.from);
}

async function loop() {
  while (!stop) {
    let cfg = null;
    try {
      cfg = await loadConfig();
      if (!cfg) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
      const r = await fetch(`https://api.telegram.org/bot${cfg.token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`,
        { signal: AbortSignal.timeout(35_000) });
      const j = await r.json();
      if (!j.ok) { logger.warn({ description: j.description }, 'summary bot: getUpdates failed'); await new Promise((res) => setTimeout(res, 10_000)); continue; }
      for (const u of j.result) {
        offset = u.update_id + 1;
        if (u.message) await handle(cfg, u.message);
        else if (u.callback_query) await handleButton(cfg, u.callback_query);
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

/** For tests only: the message / button handlers (no polling). */
export const _forTests = { handle, handleButton };
