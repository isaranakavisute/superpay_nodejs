import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { internal as configOf } from '../config-admin/config.service.js';
import logger from '../logger.js';
import { recordChat } from './announcement.service.js';

/**
 * @OptionPaySupportBot: answers scripted questions (support_faqs, edited in the admin
 * console → บอทตอบคำถาม) in approved Telegram groups. A message gets an answer only when
 * it is close enough to a question or contains one of its keywords; anything else is
 * ordinary chat and is left alone.
 */

// ---------- matching ----------

// Polite particles and filler carry no meaning for matching.
const FILLER = /(ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|จ้า|จ้ะ|นะคะ|นะครับ|หน่อย|ด้วย|please|pls)/g;
export const normalize = (t) => String(t ?? '').toLowerCase().replace(/[่-๋]/g, '').replace(FILLER, '')
  .replace(/[^0-9a-z฀-๿]/g, '');
const bigrams = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) ?? 0) + 1); } return out; };
/** Dice similarity of character pairs (works for Thai, which has no spaces). */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let both = 0;
  for (const [g, n] of A) both += Math.min(n, B.get(g) ?? 0);
  const total = Math.max(1, a.length - 1) + Math.max(1, b.length - 1);
  return (2 * both) / total;
}

/** Best scripted answer for a message, or null. score: 0–1 (keyword hit = 1). */
export function bestMatch(text, faqs, minScore) {
  const msg = normalize(text);
  if (msg.length < 2) return null;
  let best = null;
  for (const f of faqs) {
    if (!f.enabled) continue;
    const keys = f.keywords.split(',').map((k) => k.trim()).filter((k) => normalize(k).length >= 2);
    // The longest keyword found wins ("ไม่เห็นเมนู" over "ถอนเงิน" in "ทำไมไม่เห็นเมนูถอนเงิน").
    const keyHit = keys.filter((k) => msg.includes(normalize(k))).sort((a, b) => normalize(b).length - normalize(a).length)[0];
    const q = normalize(f.question);
    // Whole-question similarity, plus "the question is inside a longer message".
    const score = keyHit ? 1 : Math.max(dice(msg, q), msg.length > q.length && msg.includes(q) ? 0.95 : 0);
    const rank = score + (keyHit ? normalize(keyHit).length / 1000 : 0);
    if (!best || rank > best.rank) best = { faq: f, score, rank, by: keyHit ? `คำสำคัญ “${keyHit}”` : 'ความคล้ายของคำถาม' };
  }
  return best && best.score >= minScore ? best : null;
}

// ---------- admin CRUD ----------

const COLS = `id, question, keywords, answer, enabled, sort, hits, last_hit_at AS "lastHitAt", updated_at AS "updatedAt", updated_by AS "updatedBy"`;
export const faqSchema = z.object({
  question: z.string().trim().min(2).max(500),
  keywords: z.string().trim().max(1000).default(''),
  answer: z.string().trim().min(1).max(3500),
  enabled: z.boolean().default(true),
  sort: z.coerce.number().int().min(0).max(100000).default(0),
});
const audit = (actor, action, ref, detail) => query(
  `INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'setting', $3, $4)`, [actor ?? 'console', action, ref, detail]);

export async function listFaqs() {
  const { rows } = await query(`SELECT ${COLS} FROM support_faqs ORDER BY sort, id`);
  return rows;
}
export async function createFaq(actor, b) {
  const { rows } = await query(`INSERT INTO support_faqs (question, keywords, answer, enabled, sort, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [b.question, b.keywords, b.answer, b.enabled, b.sort, actor]);
  await audit(actor, 'supportbot.faq_create', String(rows[0].id), `เพิ่มคำถาม: ${b.question}`);
  return { faq: rows[0] };
}
export async function updateFaq(actor, id, b) {
  const { rows } = await query(`UPDATE support_faqs SET question = $2, keywords = $3, answer = $4, enabled = $5, sort = $6, updated_by = $7, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`, [id, b.question, b.keywords, b.answer, b.enabled, b.sort, actor]);
  if (!rows[0]) throw new NotFoundError('ไม่พบคำถามนี้');
  await audit(actor, 'supportbot.faq_update', String(id), `แก้ไขคำถาม: ${b.question}`);
  return { faq: rows[0] };
}
export async function deleteFaq(actor, id) {
  const { rows } = await query('DELETE FROM support_faqs WHERE id = $1 RETURNING question', [id]);
  if (!rows[0]) throw new NotFoundError('ไม่พบคำถามนี้');
  await audit(actor, 'supportbot.faq_delete', String(id), `ลบคำถาม: ${rows[0].question}`);
  return { success: true };
}
/** Admin "test" box: which answer would this message get? */
export async function testMatch(text) {
  const cfg = await configOf('supportBot');
  const faqs = await listFaqs();
  const m = bestMatch(text, faqs, cfg.minScore);
  const ranked = faqs.filter((f) => f.enabled).map((f) => ({ id: f.id, question: f.question, score: bestMatch(text, [f], 0)?.score ?? 0 }))
    .sort((a, b) => b.score - a.score).slice(0, 3);
  return { match: m ? { id: m.faq.id, question: m.faq.question, answer: m.faq.answer, score: m.score, by: m.by } : null, minScore: cfg.minScore, top: ranked };
}

// ---------- Telegram ----------

const tg = (token, method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
}).then((r) => r.json());

export async function checkSecret(header) {
  const cfg = await configOf('supportBot');
  const a = Buffer.from(String(header ?? '')), b = Buffer.from(cfg.webhookSecret || '');
  // Not tied to the FAQ on/off switch: group joins / leaves must still be recorded for ประชาสัมพันธ์.
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function handleUpdate(update) {
  // Added to / removed from a group: remembered for ประชาสัมพันธ์ (announcements).
  const cm = update?.my_chat_member;
  if (cm?.chat) { await recordChat(cm.chat, cm.new_chat_member?.status ?? 'member'); return; }
  const msg = update?.message;
  if (msg?.chat && msg.chat.type !== 'private') await recordChat(msg.chat, 'member').catch(() => {});
  if (!msg?.chat || msg.from?.is_bot) return;
  const cfg = await configOf('supportBot');
  // FAQ answers only when บอทตอบคำถาม is switched on (ประชาสัมพันธ์ works either way).
  if (!cfg.enabled || !cfg.botToken) return;
  const text = (msg.text ?? msg.caption ?? '').trim();
  if (!text) return;   // photos, stickers, voice… are not questions
  const chatId = String(msg.chat.id);
  const allowed = cfg.allowedChatIds.split(',').map((x) => x.trim()).filter(Boolean);
  const reply = (t) => tg(cfg.botToken, 'sendMessage', { chat_id: msg.chat.id, text: t, reply_to_message_id: msg.message_id }).catch(() => {});
  const isCommand = /^\/(faq|help|start)(@\w+)?\b/i.test(text);
  const isPrivate = msg.chat.type === 'private';
  // Groups: every group the bot is in (default) or only approved ones; private chats: anyone unless switched off.
  if (!allowed.includes(chatId) && !(isPrivate ? cfg.allowPrivate : cfg.allGroups)) {
    if (isCommand || msg.chat.type === 'private') {
      await audit('telegram', 'supportbot.denied', chatId, `แชทที่ยังไม่ได้รับอนุญาตใช้บอทตอบคำถาม: ${msg.chat.title ?? msg.from?.username ?? ''}`);
      await reply(`บอทนี้ยังไม่ได้เปิดให้แชทนี้ใช้งาน\nchat id: ${chatId}`);
    }
    return;
  }
  const faqs = await listFaqs();
  const list = faqs.filter((f) => f.enabled).map((f, i) => `${i + 1}. ${f.question}`).join('\n');
  if (isCommand) {
    const hello = isPrivate && /^\/start/i.test(text) ? 'สวัสดีครับ 👋 บอทตอบคำถามของ Option Pay — พิมพ์คำถามได้เลย\n\n' : '';
    await reply(list ? `${hello}ถามคำถามเหล่านี้ได้เลย:\n\n${list}` : `${hello}ยังไม่มีคำถามที่ตั้งไว้`);
    return;
  }
  const m = bestMatch(text, faqs, cfg.minScore);
  if (!m) {
    // In a group, ordinary chat is left alone; in a private chat the person is talking to the bot.
    if (isPrivate) await reply('ขออภัย ยังไม่มีคำตอบสำหรับคำถามนี้ — พิมพ์ /faq เพื่อดูคำถามที่ถามได้ หรือติดต่อเจ้าหน้าที่ Option Pay');
    return;
  }
  await reply(m.faq.answer);
  await query('UPDATE support_faqs SET hits = hits + 1, last_hit_at = now() WHERE id = $1', [m.faq.id]).catch((err) => logger.warn({ err: err.message }, 'support bot: hit count'));
}
