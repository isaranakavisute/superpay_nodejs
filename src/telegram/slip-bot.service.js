import { timingSafeEqual } from 'node:crypto';
import { tgSend } from '../shared/telegram-send.js';
import { pool, query } from '../db/pool.js';
import { internal as configOf } from '../config-admin/config.service.js';
import logger from '../logger.js';
import { PENDING_TEXT, verifySlip } from '../merchant-api/slip-verify.js';
import { ocrCheckSlip } from '../merchant-api/slip-ocr.js';
import { decideSlip, orderNotPendingText } from '../merchant-api/v1.service.js';
import { leftOf } from '../merchant-api/slip-transfers.js';
import { readTxnText } from '../merchant-api/txn-ocr.js';
import { isSampleSlip, qrReason, SAMPLE_SLIP_MESSAGE, slipFingerprint } from '../shared/slip-fingerprint.js';
import { accountMatches, nameMatches, normalizeSlip } from '../merchant-api/slip-match.js';

/**
 * @OptionPayBot: a user sends an image; the bot first asks whether to validate it as a slip (ใช่ / ไม่) —
 * "ไม่" ends there until the next image. On "ใช่" it asks the slip provider (EasySlip)
 * whether it is a real transfer and replies "valid slip" or "invalid slip" with the reason.
 * A slip already used on an Option Pay order, or already checked here, is a duplicate.
 * Every group it is added to and every private chat may use it (slipBot.allGroups / allowPrivate, default on);
 * with a switch off, only chats listed in slipBot.allowedChatIds — each check spends quota.
 */
const MAX_BYTES = 8 << 20;
// Every post is paced per chat and retried on Telegram 429 (shared rule — see shared/telegram-send.js).
const tg = (token, method, body) => tgSend(token, method, body);

const baht = (n) => `฿${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (d) => new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });

/** Telegram's X-Telegram-Bot-Api-Secret-Token must match the secret given to setWebhook. */
export async function checkSecret(header) {
  const cfg = await configOf('slipBot');
  const a = Buffer.from(String(header ?? '')), b = Buffer.from(cfg.webhookSecret || '');
  return cfg.enabled && b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** The image of a message: a photo (largest size) or an image sent as a file. */
function imageOf(msg) {
  if (msg.photo?.length) return { fileId: msg.photo.at(-1).file_id, mime: 'image/jpeg', size: msg.photo.at(-1).file_size };
  const d = msg.document;
  if (d && /^image\/(jpeg|png|webp)$/.test(d.mime_type ?? '')) return { fileId: d.file_id, mime: d.mime_type, size: d.file_size };
  return null;
}

async function downloadOnce(token, fileId) {
  const f = await tg(token, 'getFile', { file_id: fileId });
  if (!f.ok) throw new Error(f.description ?? 'getFile failed');
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Fingerprint (QR + hash) of an image buffer: computed once per downloaded image (the download cache returns the same Buffer).
const prints = new WeakMap();
function fingerprintOf(buf, mime) {
  if (!prints.has(buf)) prints.set(buf, slipFingerprint(buf, mime).catch((err) => { prints.delete(buf); throw err; }));
  return prints.get(buf);
}

/** "typing…" in the chat until `done` settles (Telegram shows it for ~5 s per call). */
function typingWhile(token, chatId, done) {
  const ping = () => tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  ping();
  const t = setInterval(ping, 4000);
  return done.finally(() => clearInterval(t));
}

// One image is needed several times in a check (TXN search, earlier result, the check itself): fetched once,
// kept for a few minutes, and retried — the link to Telegram occasionally drops a request.
const images = new Map();
const IMAGE_KEEP_MS = 5 * 60_000;
async function download(token, fileId) {
  const hit = images.get(fileId);
  if (hit && Date.now() - hit.at < IMAGE_KEEP_MS) return hit.buf;
  let last;
  for (const wait of [0, 1000, 2500]) {
    if (wait) await new Promise((res) => setTimeout(res, wait));
    try {
      const buf = await downloadOnce(token, fileId);
      for (const [k, v] of images) if (Date.now() - v.at >= IMAGE_KEEP_MS) images.delete(k);
      images.set(fileId, { buf, at: Date.now() });
      return buf;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const CHECKED_BY = { easyslip: 'EasySlip (ธนาคาร)', slipok: 'SlipOK (ธนาคาร)', ocr: 'อ่านจากภาพ + ผู้ดูแล', none: 'ผู้ดูแล' };
const STATUS_TH = { pending: 'รอชำระ', approved: 'ชำระแล้ว (อนุมัติแล้ว)', rejected: 'ปฏิเสธ / ยกเลิก', refunded: 'คืนเงินแล้ว', expired: 'หมดอายุ' };

/** Full detail of the Option Pay order a slip is already attached to. */
async function orderDetail(paymentId) {
  const { rows: [p] } = await query(
    `SELECT p.ref, p.merchant_order_id, p.customer_name, p.amount, p.fee, p.status, p.source, p.description, p.created_at, p.completed_at,
            p.reviewed_by, p.review_note, p.refunded_amount, m.name AS shop, m.slug, a.bank_code, a.account_no, a.account_name,
            s.uploaded_at, s.uploaded_by, s.provider, s.trans_ref
       FROM payments p LEFT JOIN merchants m ON m.id = p.merchant_id JOIN bank_accounts a ON a.id = p.bank_account_id
       LEFT JOIN payment_slips s ON s.payment_id = p.id
      WHERE p.id = $1`,
    [paymentId],
  );
  const lines = [
    `📄 รายละเอียดรายการ ${p.ref}`,
    `ร้านค้า: ${p.shop ?? 'ไม่ผูกร้าน'}${p.slug && p.slug !== p.shop ? ` (${p.slug})` : ''}`,
    p.merchant_order_id ? `เลขออเดอร์: ${p.merchant_order_id}` : null,
    p.description ? `รายละเอียด: ${p.description}` : null,
    `ลูกค้า: ${p.customer_name && p.customer_name !== '-' ? p.customer_name : '-'}`,
    `ยอด: ${baht(p.amount)} · ค่าธรรมเนียม ${baht(p.fee)}${Number(p.refunded_amount) > 0 ? ` · คืนแล้ว ${baht(p.refunded_amount)}` : ''}`,
    `สถานะ: ${STATUS_TH[p.status] ?? p.status}`,
    `บัญชีรับเงิน: ${p.bank_code} ${p.account_no} (${p.account_name ?? '-'})`,
    `สร้างเมื่อ: ${when(p.created_at)} · ช่องทาง: ${p.source}`,
    `แนบสลิปเมื่อ: ${p.uploaded_at ? when(p.uploaded_at) : '-'}${p.provider ? ` · ตรวจโดย ${CHECKED_BY[p.provider] ?? p.provider}` : ''}`,
    p.completed_at ? `${p.status === 'approved' || p.status === 'refunded' ? 'อนุมัติ' : 'ปิดรายการ'}เมื่อ: ${when(p.completed_at)}${p.reviewed_by ? ` โดย ${p.reviewed_by}` : ''}` : null,
    p.trans_ref ? `เลขอ้างอิงธนาคาร: ${p.trans_ref}` : null,
  ];
  return lines.filter((x) => x !== null).join('\n');
}

/**
 * Without an order (typed answers): where this slip / transfer already paid an Option Pay order — the API's rule
 * (a slip refused on its order doesn't count unless an admin approved that order anyway). The bot's own earlier
 * checks are only mentioned (botNote): the API never refuses a slip for having been checked in the bot.
 */
async function seenBefore({ transRef, sha256, qr }, excludePaymentId = null, recheck = false) {
  const { rows: onOrder } = await query(
    `SELECT p.id, p.ref, s.uploaded_at FROM payment_slips s JOIN payments p ON p.id = s.payment_id
      WHERE (coalesce(s.verify_result->>'decision', '') <> 'invalid' OR p.status IN ('approved', 'refunded')) AND ($4::int IS NULL OR p.id <> $4)
        AND (($1::text IS NOT NULL AND s.trans_ref = $1) OR s.image_sha256 = $2 OR ($3::text IS NOT NULL AND s.qr_payload = $3))
      ORDER BY s.uploaded_at LIMIT 1`,
    [transRef ?? null, sha256, qr, excludePaymentId],
  );
  if (onOrder[0]) {
    return { reason: 'สลิปนี้ถูกใช้กับรายการอื่นแล้ว — ใช้ซ้ำไม่ได้', detail: await orderDetail(onOrder[0].id) };
  }
  // Re-checking on request: the bot's own earlier checks of this slip don't make it a duplicate.
  if (recheck) return null;
  const { rows: here } = await query(
    `SELECT created_at, from_user, amount, trans_ref FROM telegram_slip_checks
      WHERE result = 'valid' AND (($1::text IS NOT NULL AND trans_ref = $1) OR image_sha256 = $2 OR ($3::text IS NOT NULL AND qr_payload = $3))
      ORDER BY created_at LIMIT 1`,
    [transRef ?? null, sha256, qr],
  );
  if (here[0]) return { botNote: `สลิปนี้เคยส่งตรวจในบอทแล้วเมื่อ ${when(here[0].created_at)}${here[0].from_user ? ` (โดย ${here[0].from_user})` : ''} — ยังไม่ได้ผูกกับรายการใดใน Option Pay` };
  return null;
}

const baht2 = (n) => `฿${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Runs the API's own decision in a transaction that is always rolled back: the bot reports, it never changes anything. */
async function dryRun(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

/**
 * A slip checked against an Option Pay order: EXACTLY what the merchant API would decide if the shop sent this slip
 * for that order (decideSlip in v1.service.js — amount, transfer time, receiving account, sender, slip age, carry-over,
 * left-over, slip + left-over, duplicate use, bank still processing, image reading when the bank can't answer), with
 * the API's own reason and per-check results. Nothing is attached, approved or cancelled.
 */
async function checkAgainstOrder(buf, mime, fp, p) {
  if (!['pending', 'expired'].includes(p.status)) {
    const { rows } = await query(
      `SELECT 1 FROM payment_slips WHERE payment_id = $1 AND (image_sha256 = $2 OR ($3::text IS NOT NULL AND qr_payload = $3))`, [p.id, fp.sha256, fp.qr ?? null]);
    const own = rows[0] && ['approved', 'refunded'].includes(p.status);
    return { result: 'invalid', reason: orderNotPendingText(p.status), problems: own ? ['สลิปนี้คือสลิปที่ใช้ชำระรายการนี้แล้ว'] : [], detail: await orderDetail(p.id), fp, order: p };
  }
  const v = await verifySlip(buf, mime);
  // Same as the API: "not found" right after a transfer is re-checked first (rule 17 Oct 2026), not refused.
  if (v.verified === false && v.notFound) Object.assign(v, { verified: null, pending: true, notFoundRetry: true });
  // Same as the API: no answer from the bank → read the image; the bank still processing → "will be re-checked".
  const ocr = v.verified === null && !v.pending ? await ocrCheckSlip(buf, p, v.cfg) : null;
  if (v.pending) v.message = v.notFoundRetry ? 'ธนาคารยังไม่พบรายการโอนนี้ (อาจเพิ่งโอน) — ระบบจะตรวจซ้ำอัตโนมัติ' : PENDING_TEXT;
  const d = await dryRun((c) => decideSlip(c, p, v, fp, ocr));
  const usedOn = d.reusedOn && d.reusedOn !== 'อื่น' ? (await query('SELECT id FROM payments WHERE ref = $1', [d.reusedOn])).rows[0] : null;
  return {
    result: d.decision === 'approve' ? 'valid' : d.decision === 'invalid' ? 'invalid' : 'review',
    reason: d.reason, problems: d.mismatches.length > 1 ? d.mismatches : [], decision: d, v, fp, order: p,
    detail: usedOn ? await orderDetail(usedOn.id) : null,
  };
}

/** One typed answer against the bank's reading of the slip → { problem } | { note } | { matched }. */
function checkAnswer(step, v, value) {
  const slip = normalizeSlip(v.provider, v.raw);
  if (step === 'amount') {
    // A transfer that already paid part of an order: the API accepts an order its left-over covers.
    if (v.leftover != null) {
      return value > v.leftover + 0.009
        ? { problem: `ยอดคงเหลือของการโอนนี้ ${baht2(v.leftover)} — ไม่พอสำหรับออเดอร์ยอด ${baht2(value)} · สร้างออเดอร์ยอดไม่เกิน ${baht2(v.leftover)} เพื่อใช้ยอดนี้` }
        : { matched: `ยอด ${baht2(value)} (จากยอดคงเหลือ ${baht2(v.leftover)})` };
    }
    return Math.abs(Number(v.amount) - value) > 0.009
      ? { problem: `ยอดเงินในสลิป ${baht2(v.amount)} ไม่ตรงกับยอดที่ต้องชำระ ${baht2(value)} — ต้องโอนตรงยอดทุกสตางค์` } : { matched: `ยอด ${baht2(value)}` };
  }
  if (step === 'account') {
    const acct = accountMatches(slip?.receiverAccount, value) ?? accountMatches(slip?.receiverProxy, value);
    if (acct === false) return { problem: `เลขบัญชีปลายทางในสลิป (${slip?.receiverAccount ?? slip?.receiverProxy}) ไม่ตรงกับที่ระบุ (${value})` };
    return acct === null ? { note: 'สลิปไม่แสดงเลขบัญชีปลายทาง — ยืนยันเลขบัญชีไม่ได้' } : { matched: `เลขบัญชีปลายทาง ${value}` };
  }
  const names = step === 'name' ? slip?.receiverNames ?? [] : slip?.senderNames ?? [];
  const ok = nameMatches(names, value);
  const label = step === 'name' ? 'ชื่อบัญชีปลายทาง' : 'ชื่อผู้โอน';
  // Someone may pay for someone else: a different sender is a warning, never a failure.
  if (ok === false) return step === 'sender' ? { note: `ชื่อผู้โอนในสลิป (${names[0]}) ไม่ตรงกับที่ระบุ (${value}) — อาจโอนแทนกัน` } : { problem: `${label}ในสลิป (${names[0]}) ไม่ตรงกับที่ระบุ (${value})` };
  return ok === null ? { note: `ยืนยัน${label}จากสลิปไม่ได้` } : { matched: `${step === 'name' ? label : 'ผู้โอน'} ${value}` };
}

/** The API's slip-age rule without an order (slipMaxAgeHours = 0: transferred today, Bangkok). */
function ageProblem(v) {
  const cfg = v.cfg ?? {};
  if (!cfg.slipAgeCheck || !v.date) return null;
  if (cfg.slipMaxAgeHours === 0) {
    const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    return day(v.date) === day(Date.now()) ? null : 'สลิปต้องเป็นการโอนวันเดียวกับที่สร้างรายการ';
  }
  return Date.now() - new Date(v.date).getTime() > cfg.slipMaxAgeHours * 3_600_000 ? `สลิปเก่าเกิน ${cfg.slipMaxAgeHours} ชั่วโมง — ใช้สลิปเก่าไม่ได้` : null;
}

/**
 * Verify one slip image → { result: valid | invalid | review | unverified, reason, ... }.
 * With an order (`expect.kind === 'order'`): the merchant API's decision (checkAgainstOrder). Without one (typed
 * answers): the same bank check, slip-age and duplicate / left-over rules, then each typed answer (checkAnswer).
 */
export async function checkSlip(buf, mime, expect = null, { recheck = false } = {}) {
  const fp = await fingerprintOf(buf, mime);
  if (isSampleSlip(fp)) return { result: 'invalid', reason: SAMPLE_SLIP_MESSAGE, fp };
  if (expect?.kind === 'order') return checkAgainstOrder(buf, mime, fp, expect.order);
  const v = await verifySlip(buf, mime);
  // "No QR" from the provider: say what the image actually has (a fake QR, or a QR that isn't a slip's).
  if (v.verified === false && v.notFound) return { result: 'review', reason: 'ธนาคารยังไม่พบรายการโอนนี้ (อาจเพิ่งโอน) — ระบบจะตรวจซ้ำอัตโนมัติ', fp };
  if (v.verified === false) return { result: 'invalid', reason: (/QR/.test(v.message ?? '') && qrReason(fp)) || v.message || 'สลิปไม่ถูกต้อง', fp };
  if (v.pending) return { result: 'review', reason: PENDING_TEXT, fp };
  if (v.verified !== true) return { result: 'unverified', reason: v.message ?? 'ผู้ให้บริการตรวจสลิปไม่ตอบ', fp };
  const notes = [];
  // Already paid an order: refused like the API — unless part of the money is left (then only up to that amount).
  const t = v.transRef ? (await query('SELECT * FROM slip_transfers WHERE trans_ref = $1', [v.transRef])).rows[0] : null;
  const open = t && Number(t.used) > 0 && leftOf(t) > 0.009 && t.leftover_until && new Date(t.leftover_until) > new Date();
  if (open) {
    const paid = (await query(`SELECT p.ref, u.amount FROM slip_transfer_uses u JOIN payments p ON p.id = u.payment_id WHERE u.transfer_id = $1 ORDER BY u.id`, [t.id])).rows;
    v.leftover = leftOf(t);
    notes.push(`เงินโอนนี้ใช้ชำระ ${paid.map((x) => `${x.ref} ${baht2(x.amount)}`).join(', ')} แล้ว — คงเหลือ ${baht2(v.leftover)} ใช้กับออเดอร์ยอดไม่เกิน ${baht2(v.leftover)} ของลูกค้าคนเดิมได้ถึง ${when(t.leftover_until)}`);
  } else {
    const dup = await seenBefore({ transRef: v.transRef, sha256: fp.sha256, qr: fp.qr }, null, recheck);
    if (dup?.reason) return { result: 'invalid', reason: dup.reason, detail: dup.detail, fp, v };
    if (dup?.botNote) notes.push(dup.botNote);
    const age = ageProblem(v);
    if (age) return { result: 'invalid', reason: age, fp, v };
  }
  return { result: 'valid', fp, v, matched: [], notes, carried: null, order: null };
}

/**
 * The bot's answer — one line (agreed 17 Oct 2026): "✅ passed", or "❌" with the single main reason it fails.
 * The verdict itself is the merchant API's (checkAgainstOrder / decideSlip); only the wording is short here.
 */
function replyText(r) {
  if (r.result === 'valid') return '✅ passed';
  if (r.result === 'invalid') return `❌ ${r.decision?.mismatches?.[0] ?? r.problems?.[0] ?? r.reason ?? 'สลิปไม่ผ่านการตรวจ'}`;
  if (r.result === 'review') return `⚠️ ต้องให้ผู้ดูแลตรวจ — ${String(r.reason ?? '').split(' · ')[0] || 'ระบบยืนยันเองไม่ได้'}`;
  return `⚠️ ตรวจสลิปไม่ได้ในขณะนี้ — ${r.reason ?? 'ลองส่งใหม่อีกครั้งภายหลัง'}`;
}

const HELP = 'ส่งรูปสลิปโอนเงินมาที่นี่ — ถ้าพิมพ์เลขที่รายการ (เช่น TXN172919) ในข้อความที่แนบกับรูป บอทจะตรวจสลิปกับรายการนั้นทันที ไม่ถามคำถาม · ถ้าไม่มี บอทจะถามก่อนว่าต้องการตรวจสลิปหรือไม่ (ถ้ามีเลข TXN อยู่ในภาพ บอทจะใช้เลขนั้นแทนการถามเลขที่รายการ) ถ้าตอบ “ใช่” จะถามรายการที่ต้องชำระ (เลขที่รายการ หรือ ยอด/บัญชีปลายทาง) แล้วตรวจกับธนาคาร (EasySlip) และตอบว่า valid slip หรือ invalid slip พร้อมเหตุผล\n\nแนะนำ: ส่งแบบ “ไฟล์” (File) จะชัดกว่าส่งแบบรูปภาพที่ Telegram บีบอัด';

/** Handle one Telegram update (called after the webhook has answered 200). */
// ---------- asking for the expected payment before verifying ----------

const SESSION_MIN = 10;
/** Reading a TXN printed in the image must not keep the user waiting long; past this the usual questions start. */
const IMAGE_TXN_TIMEOUT_MS = 12_000;
const ASK = {
  confirm: 'ต้องการตรวจสลิป (slip validation) ภาพนี้หรือไม่? 🔍\nกด / พิมพ์ “ใช่” เพื่อตรวจ หรือ “ไม่” เพื่อไม่ตรวจ',
  ref: 'ก่อนตรวจสลิป กรุณาระบุรายการที่ต้องชำระ 🧾\n\nพิมพ์ “เลขที่รายการ” (ขึ้นต้นด้วย TXN) หรือ “เลขออเดอร์ของร้าน”\nถ้าไม่มี พิมพ์ “ไม่มี” แล้วบอทจะถามรายละเอียดทีละข้อ\n(พิมพ์ “ยกเลิก” เพื่อยกเลิก)',
  amount: 'ข้อ 1/4 — ยอดเงินที่ต้องโอนกี่บาท? (เช่น 3000 หรือ 1,250.50)',
  account: 'ข้อ 2/4 — เลขบัญชีปลายทาง หรือเบอร์พร้อมเพย์ ที่ต้องโอนเข้า?',
  name: 'ข้อ 3/4 — ชื่อบัญชีปลายทาง?',
  sender: 'ข้อ 4/4 — ชื่อบัญชีผู้โอน? (ถ้าไม่ต้องการตรวจ พิมพ์ “ข้าม”)',
  recheck: 'ต้องการตรวจสลิปนี้ใหม่หรือไม่?\nพิมพ์ “ใช่” เพื่อตรวจใหม่ หรือ “ไม่” เพื่อใช้ผลเดิม',
};
const NEXT = { amount: 'account', account: 'name', name: 'sender' };
const YES = /^(ใช่|ตรวจ|ตรวจใหม่|ok|yes|y)$/i;
const NO = /^(ไม่|ไม่ต้อง|ไม่ตรวจ|no|n)$/i;
// ใช่ / ไม่ buttons under the question — only for the person who sent the image (selective: the reply targets their message).
const YES_NO = { keyboard: [[{ text: 'ใช่' }, { text: 'ไม่' }]], one_time_keyboard: true, resize_keyboard: true, selective: true };
const NO_KEYBOARD = { remove_keyboard: true, selective: true };

const getSession = async (chatId, userId) => (await query(`SELECT * FROM telegram_slip_sessions WHERE chat_id = $1 AND user_id = $2 AND expires_at > now()`, [chatId, userId])).rows[0] ?? null;
const saveSession = (chatId, userId, f) => query(
  `INSERT INTO telegram_slip_sessions (chat_id, user_id, file_id, mime, message_id, step, data, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => ${SESSION_MIN}))
   ON CONFLICT (chat_id, user_id) DO UPDATE SET file_id = EXCLUDED.file_id, mime = EXCLUDED.mime, message_id = EXCLUDED.message_id, step = EXCLUDED.step, data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
  [chatId, userId, f.file_id, f.mime, f.message_id, f.step, JSON.stringify(f.data ?? {})],
);
const endSession = (chatId, userId) => query('DELETE FROM telegram_slip_sessions WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);

/** An Option Pay order by TXN ref or the shop's Order ID (with its receiving account). */
/**
 * TXN numbers written anywhere in a text (a photo's caption or the text read from the image — top, middle or
 * bottom alike): "TXN172919", "txn 172919", "TXN-172919"; an O read in place of a zero is accepted.
 */
export function txnRefsIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/T\s*X\s*N[\s\-:#.]*([0-9Oo]{4,12})(?![0-9Oo])/gi)) {
    const ref = `TXN${m[1].replace(/[Oo]/g, '0')}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** Does the photo's caption name an order — a TXN number anywhere in it, or exactly the shop's order number? */
export async function captionNamesOrder(caption) {
  const c = String(caption ?? '').trim();
  if (!c) return false;
  if (txnRefsIn(c).length) return true;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(c) && (await findOrder(c)).length > 0;
}

/** The order a slip image points to, if any: TXN in the caption first, then TXN read from the image itself. */
async function orderHint(cfg, captionText, fileId) {
  const caption = String(captionText ?? '').trim();
  const fromCaption = txnRefsIn(caption);
  // A caption that is just the shop's order number (e.g. PD-…) counts too.
  if (!fromCaption.length && /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(caption) && (await findOrder(caption)).length === 1) return { ref: caption, where: 'ข้อความที่แนบมากับรูป' };
  let refs = fromCaption;
  let where = 'ข้อความที่แนบมากับรูป';
  if (!refs.length) {
    try {
      const text = await Promise.race([
        download(cfg.botToken, fileId).then((buf) => readTxnText(buf)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), IMAGE_TXN_TIMEOUT_MS)),
      ]);
      refs = txnRefsIn(text);
      where = 'ภาพ';
    } catch (err) {
      logger.warn({ err: err.message }, 'slip bot: reading TXN from the image failed');
    }
  }
  if (!refs.length) return null;
  const known = [];
  for (const r of refs) if ((await findOrder(r)).length) known.push(r);
  if (known.length === 1) return { ref: known[0], where };
  if (known.length > 1) return { ask: `พบเลขรายการหลายรายการใน${where}: ${known.join(', ')} — กรุณาพิมพ์เลขที่รายการที่ต้องการตรวจ` };
  return { unknown: refs[0], where };
}

async function findOrder(text) {
  const t = text.trim().replace(/\s+/g, '');
  const { rows } = await query(
    `SELECT p.*, a.promptpay_id, a.bank_code AS acct_bank, a.account_name, a.account_no
       FROM payments p JOIN bank_accounts a ON a.id = p.bank_account_id
      WHERE upper(p.ref) = upper($1) OR p.merchant_order_id = $1 ORDER BY p.id DESC LIMIT 2`,
    [t],
  );
  return rows;
}

/** Downloads the slip and checks it (against `expect` when given). */
async function runCheck(cfg, sess, expect) {
  try {
    return await checkSlip(await download(cfg.botToken, sess.file_id), sess.mime, expect, { recheck: !!sess.data?.recheck });
  } catch (err) {
    logger.warn({ err: err.message }, 'slip bot: check failed');
    return { result: 'unverified', reason: 'ดาวน์โหลดหรือตรวจรูปไม่สำเร็จ', fp: {} };
  }
}

/** Logs the outcome (the duplicate check reads valid ones) and returns the reply. */
async function finish(chatId, userId, sess, r, who) {
  await endSession(chatId, userId);
  const reply = replyText(r);
  await query(
    `INSERT INTO telegram_slip_checks (chat_id, message_id, from_user, result, reason, trans_ref, image_sha256, qr_payload, amount, reply_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [chatId, sess.message_id, who, r.result, [r.reason, ...(r.problems ?? [])].filter(Boolean).join(' · ') || null, r.v?.transRef ?? null, r.fp?.sha256 ?? null, r.fp?.qr ?? null, r.v?.amount ?? null, reply],
  );
  return reply;
}

/**
 * A slip the bot has already judged (same image, or the same slip QR in another photo) gets that
 * earlier result again — no new questions, no new check. "Couldn't check" results don't count.
 */
async function priorResult(fp) {
  const { rows } = await query(
    `SELECT created_at, from_user, result, reason, reply_text FROM telegram_slip_checks
      WHERE result IN ('valid', 'invalid', 'review') AND (image_sha256 = $1 OR ($2::text IS NOT NULL AND qr_payload = $2))
      ORDER BY created_at DESC LIMIT 1`,
    [fp.sha256, fp.qr ?? null],
  );
  const h = rows[0];
  if (!h) return null;
  const earlier = h.reply_text ?? (h.result === 'valid' ? '✅ valid slip' : `❌ invalid slip\n\nเหตุผล: ${h.reason ?? '-'}`);
  return `🔁 สลิปนี้เคยตรวจแล้วเมื่อ ${when(h.created_at)}${h.from_user ? ` (ส่งโดย ${h.from_user})` : ''} — ผลเดิม:\n\n${earlier}`;
}

/** Runs the check for an Option Pay order and returns the reply. */
async function verifySession(cfg, chatId, userId, sess, expect, who) {
  return finish(chatId, userId, sess, await runCheck(cfg, sess, expect), who);
}

/**
 * "ใช่" to the first question: the slip-validation flow starts. A slip the bot has judged before gets that
 * result and the re-check question; otherwise the questions about the expected payment begin.
 */
/** The earlier result for this slip image, if it was checked before (null when not, or when it can't be read). */
async function priorOf(cfg, sess) {
  try {
    return await priorResult(await fingerprintOf(await download(cfg.botToken, sess.file_id), sess.mime));
  } catch (err) {
    logger.warn({ err: err.message }, 'slip bot: download failed');
    return null;
  }
}

async function startValidation(cfg, chatId, userId, sess, who) {
  // A TXN in the caption or printed anywhere in the image replaces the "ระบุรายการ" question.
  const hint = await orderHint(cfg, sess.data?.caption, sess.file_id);
  const found = hint?.ref ? `🔍 พบเลขรายการ ${hint.ref} ใน${hint.where} — ตรวจสลิปกับรายการนี้` : null;
  const prior = await priorOf(cfg, sess);
  if (prior) {
    await saveSession(chatId, userId, { ...sess, step: 'recheck', data: { autoRef: hint?.ref ?? null } });
    return { text: `${found ? `${found}\n\n` : ''}${prior}\n\n${ASK.recheck}`, markup: YES_NO };
  }
  const next = { ...sess, step: 'ref', data: {} };
  await saveSession(chatId, userId, next);
  if (hint?.ref) {
    const reply = await answer(cfg, chatId, userId, next, hint.ref, who);
    // A final verdict is one line on its own; a follow-up question keeps the "found TXN" line.
    if (typeof reply === 'string') return /^(✅|❌|⚠️)/.test(reply) ? reply : `${found}\n\n${reply}`;
    return { ...reply, text: `${found}\n\n${reply.text}` };
  }
  if (hint?.ask) return hint.ask;
  if (hint?.unknown) return `ไม่พบรายการ ${hint.unknown} (จาก${hint.where}) — กรุณาพิมพ์เลขที่รายการ (ขึ้นต้นด้วย TXN) หรือเลขออเดอร์ของร้านอีกครั้ง หรือพิมพ์ “ไม่มี”`;
  // Ask what the slip should match first; EasySlip is called only once the answers are in.
  return ASK.ref;
}

/** One answer in an open conversation. Returns the bot's reply (text, or { text, markup }). */
async function answer(cfg, chatId, userId, sess, text, who) {
  const t = text.trim();
  if (/^(ยกเลิก|cancel)$/i.test(t)) { await endSession(chatId, userId); return 'ยกเลิกการตรวจสลิปแล้ว'; }
  const data = sess.data ?? {};
  const again = (msg) => saveSession(chatId, userId, { ...sess, data }).then(() => msg);
  switch (sess.step) {
    case 'confirm': {
      if (NO.test(t)) { await endSession(chatId, userId); return 'รับทราบ — ไม่ตรวจสลิปภาพนี้\n(ส่งรูปใหม่เมื่อต้องการตรวจ)'; }
      if (!YES.test(t)) return again(`กรุณาตอบ “ใช่” หรือ “ไม่”\n\n${ASK.confirm}`);
      return startValidation(cfg, chatId, userId, sess, who);
    }
    case 'recheck': {
      if (YES.test(t) && data.autoRef) {
        // The TXN came with the photo: re-check against it without asking again.
        const next = { ...sess, step: 'ref', data: { recheck: true } };
        await saveSession(chatId, userId, next);
        return answer(cfg, chatId, userId, next, data.autoRef, who);
      }
      if (YES.test(t)) { await saveSession(chatId, userId, { ...sess, step: 'ref', data: { recheck: true } }); return ASK.ref; }
      if (NO.test(t)) { await endSession(chatId, userId); return 'ไม่ตรวจซ้ำ — ใช้ผลการตรวจเดิม'; }
      return again(`กรุณาตอบ “ใช่” หรือ “ไม่”\n\n${ASK.recheck}`);
    }
    case 'ref': {
      if (/^(ไม่มี|ไม่ทราบ|no|none|-)$/i.test(t)) {
        // Check the slip with the bank once, now: a fake / duplicate slip fails before any question,
        // and every answer below is compared on the spot — the first mismatch ends the questions.
        const r = await runCheck(cfg, sess, null);
        if (r.result !== 'valid') return finish(chatId, userId, sess, r, who);
        const { provider, raw, amount, transRef, date, leftover } = r.v;
        await saveSession(chatId, userId, { ...sess, step: 'amount', data: { recheck: !!data.recheck, v: { provider, raw, amount, transRef, date, leftover }, fp: { sha256: r.fp.sha256, qr: r.fp.qr }, matched: [], notes: r.notes ?? [] } });
        return ASK.amount;
      }
      const found = await findOrder(t);
      if (found.length === 0) return again(`ไม่พบรายการ “${t}” — กรุณาพิมพ์เลขที่รายการ (ขึ้นต้นด้วย TXN) หรือเลขออเดอร์ของร้านอีกครั้ง หรือพิมพ์ “ไม่มี”`);
      if (found.length > 1) return again(`เลขออเดอร์ “${t}” ตรงกับหลายรายการ — กรุณาพิมพ์เลขที่รายการ (ขึ้นต้นด้วย TXN) แทน`);
      return verifySession(cfg, chatId, userId, sess, { kind: 'order', order: found[0] }, who);
    }
    case 'amount': {
      const n = Number(t.replace(/[,\s]|บาท|฿|thb/gi, ''));
      if (!(n > 0) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return again('ยอดเงินไม่ถูกต้อง — กรุณาพิมพ์เป็นตัวเลข เช่น 3000 หรือ 1,250.50');
      data.value = n; break;
    }
    case 'account': {
      const d = t.replace(/[\s-]/g, '');
      if (!/^\d{9,15}$/.test(d)) return again('เลขบัญชีไม่ถูกต้อง — กรุณาพิมพ์ตัวเลข 9–15 หลัก (เลขบัญชี เบอร์พร้อมเพย์ หรือเลขประจำตัวประชาชน)');
      data.value = d; break;
    }
    case 'name': {
      if (t.length < 2) return again('กรุณาพิมพ์ชื่อบัญชีปลายทาง');
      data.value = t; break;
    }
    case 'sender': {
      data.value = /^(ข้าม|skip|-)$/i.test(t) ? null : t;
      break;
    }
    default: await endSession(chatId, userId); return 'กรุณาเริ่มใหม่ — ส่งรูปสลิปอีกครั้ง';
  }
  if (!data.v) { await endSession(chatId, userId); return 'กรุณาเริ่มใหม่ — ส่งรูปสลิปอีกครั้ง'; }
  const base = { fp: data.fp, v: data.v };
  if (data.value !== null) {
    const c = checkAnswer(sess.step, data.v, data.value);
    if (c.problem) {
      return finish(chatId, userId, sess, { ...base, result: 'invalid', reason: `ข้อมูลในสลิปไม่ตรงกับที่ต้องชำระ (ไม่ผ่านที่${ASK[sess.step].split(' — ')[0]})`, problems: [c.problem] }, who);
    }
    if (c.matched) data.matched.push(c.matched);
    if (c.note) data.notes.push(c.note);
  }
  delete data.value;
  if (!NEXT[sess.step]) return finish(chatId, userId, sess, { ...base, result: 'valid', matched: data.matched, notes: data.notes }, who);
  await saveSession(chatId, userId, { ...sess, step: NEXT[sess.step], data });
  return ASK[NEXT[sess.step]];
}

export async function handleUpdate(update) {
  const msg = update?.message;
  if (!msg?.chat) return;
  const cfg = await configOf('slipBot');
  if (!cfg.enabled || !cfg.botToken) return;
  const chatId = String(msg.chat.id);
  // In groups the bot stays quiet: only slip images (or /start, /help) get an answer; chatting is left alone.
  const inGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const command = /^\/(start|help)(@\w+)?\b/i.test(msg.text ?? '');
  const img = imageOf(msg);
  const userId = String(msg.from?.id ?? '');
  const who = msg.from?.username ?? msg.from?.first_name ?? null;
  // A text from someone the bot is asking (amount, account…) is an answer — even in a group.
  const sess = !img && msg.text && userId ? await getSession(chatId, userId) : null;
  if (inGroup && !img && !command && !sess) return;
  const send = (reply, markup = NO_KEYBOARD) => {
    const { text, markup: m } = typeof reply === 'string' ? { text: reply, markup } : reply;
    return tg(cfg.botToken, 'sendMessage', { chat_id: msg.chat.id, text, reply_to_message_id: msg.message_id, reply_markup: m }).catch(() => {});
  };
  const allowed = cfg.allowedChatIds.split(',').map((x) => x.trim()).filter(Boolean);
  if (!allowed.includes(chatId) && !(inGroup ? cfg.allGroups !== false : cfg.allowPrivate !== false)) {
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('telegram', 'slipbot.denied', 'setting', $1, $2)`,
      [chatId, `แชทที่ยังไม่ได้รับอนุญาตใช้บอทตรวจสลิป: ${msg.chat.title ?? msg.from?.username ?? msg.from?.first_name ?? ''}`]).catch(() => {});
    await send(`บอทนี้ยังไม่ได้เปิดให้แชทนี้ใช้งาน\nchat id: ${chatId}\nแจ้งผู้ดูแลระบบ Option Pay เพื่อเพิ่ม chat id นี้`);
    return;
  }
  if (sess) {
    // In a group, ordinary chat after posting a picture isn't an answer to "ตรวจสลิปไหม?" — no nagging; the question stays open.
    if (inGroup && (sess.step === 'confirm' || sess.step === 'recheck') && !YES.test(msg.text.trim()) && !NO.test(msg.text.trim())) return;
    // Answers like "ใช่" can start the bank check (a few seconds): show "typing…" meanwhile.
    const reply = await typingWhile(cfg.botToken, msg.chat.id, answer(cfg, chatId, userId, sess, msg.text, who));
    const asksYesNo = typeof reply === 'string' && /“ใช่” หรือ “ไม่”/.test(reply);
    await send(reply, asksYesNo ? YES_NO : NO_KEYBOARD);
    return;
  }
  if (!img) { await send(HELP); return; }
  if (img.size && img.size > MAX_BYTES) { await send('❌ invalid slip\n\nเหตุผล: ไฟล์ใหญ่เกิน 8 MB'); return; }
  const fresh = { file_id: img.fileId, mime: img.mime, message_id: msg.message_id, step: 'confirm', data: { caption: msg.caption ?? null } };
  await saveSession(chatId, userId, fresh);
  // A caption that names the order (TXN… or the shop's order number) means "check this slip": no "ตรวจไหม?" question.
  if (await captionNamesOrder(msg.caption)) {
    // Say right away that the check has started (the bank check takes a few seconds), and show "typing…" until done.
    const named = txnRefsIn(msg.caption)[0] ?? String(msg.caption).trim();
    await send(`⏳ กำลังตรวจสลิปกับรายการ ${named} — สักครู่`);
    const reply = await typingWhile(cfg.botToken, msg.chat.id, startValidation(cfg, chatId, userId, fresh, who));
    const asksYesNo = typeof reply === 'string' && /“ใช่” หรือ “ไม่”/.test(reply);
    await send(reply, asksYesNo ? YES_NO : NO_KEYBOARD);
    return;
  }
  // Otherwise ask first whether to validate it as a slip (a new image replaces any open question).
  // After "ใช่" a TXN printed in the image (if any) answers the "ระบุรายการ" question.
  await send(ASK.confirm, YES_NO);
}
