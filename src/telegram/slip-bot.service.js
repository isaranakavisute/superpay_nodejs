import { timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { internal as configOf } from '../config-admin/config.service.js';
import logger from '../logger.js';
import { verifySlip } from '../merchant-api/slip-verify.js';
import { isSampleSlip, qrReason, slipFingerprint } from '../shared/slip-fingerprint.js';
import { readSlipText } from '../merchant-api/slip-ocr.js';
import { accountMatches, matchSlip, nameMatches, normalizeSlip } from '../merchant-api/slip-match.js';

/**
 * @OptionPayBot: a user sends a slip image; the bot asks the slip provider (EasySlip)
 * whether it is a real transfer and replies "valid slip" or "invalid slip" with the reason.
 * A slip already used on an Option Pay order, or already checked here, is a duplicate.
 * Every group it is added to and every private chat may use it (slipBot.allGroups / allowPrivate, default on);
 * with a switch off, only chats listed in slipBot.allowedChatIds — each check spends quota.
 */
const MAX_BYTES = 8 << 20;
const tg = (token, method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
}).then((r) => r.json());

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

async function download(token, fileId) {
  const f = await tg(token, 'getFile', { file_id: fileId });
  if (!f.ok) throw new Error(f.description ?? 'getFile failed');
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
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

/** Where this slip was seen before: an Option Pay order, or an earlier valid check by this bot. */
async function seenBefore({ transRef, sha256, qr }, excludePaymentId = null, recheck = false) {
  const { rows: onOrder } = await query(
    `SELECT p.id, p.ref, s.uploaded_at FROM payment_slips s JOIN payments p ON p.id = s.payment_id
      WHERE coalesce(s.verify_result->>'decision', '') <> 'invalid' AND ($4::int IS NULL OR p.id <> $4)
        AND (($1::text IS NOT NULL AND s.trans_ref = $1) OR s.image_sha256 = $2 OR ($3::text IS NOT NULL AND s.qr_payload = $3))
      ORDER BY s.uploaded_at LIMIT 1`,
    [transRef ?? null, sha256, qr, excludePaymentId],
  );
  if (onOrder[0]) {
    return { reason: `สลิปนี้ถูกใช้แล้วกับรายการ ${onOrder[0].ref} (เมื่อ ${when(onOrder[0].uploaded_at)})`, detail: await orderDetail(onOrder[0].id) };
  }
  // Re-checking on request: the bot's own earlier checks of this slip don't make it a duplicate.
  if (recheck) return null;
  const { rows: here } = await query(
    `SELECT created_at, from_user, amount, trans_ref FROM telegram_slip_checks
      WHERE result = 'valid' AND (($1::text IS NOT NULL AND trans_ref = $1) OR image_sha256 = $2 OR ($3::text IS NOT NULL AND qr_payload = $3))
      ORDER BY created_at LIMIT 1`,
    [transRef ?? null, sha256, qr],
  );
  if (here[0]) {
    const h = here[0];
    return {
      reason: `สลิปนี้เคยส่งตรวจแล้วเมื่อ ${when(h.created_at)} (สลิปซ้ำ)`,
      detail: [`📄 การตรวจครั้งก่อน`, `เมื่อ: ${when(h.created_at)}`, `ส่งโดย: ${h.from_user ?? '-'}`, h.amount != null ? `ยอด: ${baht(h.amount)}` : null,
        h.trans_ref ? `เลขอ้างอิงธนาคาร: ${h.trans_ref}` : null, 'ยังไม่ได้ผูกกับรายการใดใน Option Pay'].filter((x) => x !== null).join('\n'),
    };
  }
  return null;
}

const baht2 = (n) => `฿${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the slip must match: an Option Pay order (typed answers are checked one by one in checkAnswer). */
function compare(v, expect) {
  const { problems, unknown, warnings } = matchSlip(v, expect.order);
  return { problems, notes: [...unknown, ...warnings], matched: [`ยอด ${baht2(expect.order.amount)}`, `บัญชีปลายทาง ${expect.order.acct_bank} ${expect.order.account_no}`] };
}

/** One typed answer against the bank's reading of the slip → { problem } | { note } | { matched }. */
function checkAnswer(step, v, value) {
  const slip = normalizeSlip(v.provider, v.raw);
  if (step === 'amount') {
    return Math.abs(Number(v.amount) - value) > 0.009
      ? { problem: `ยอดเงินในสลิป ${baht2(v.amount)} ไม่ตรงกับยอดที่ระบุ ${baht2(value)}` } : { matched: `ยอด ${baht2(value)}` };
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

/** Verify one slip image (against `expect` when given) → { result, reason, ... }. */
export async function checkSlip(buf, mime, expect = null, { recheck = false } = {}) {
  const fp = slipFingerprint(buf, mime);
  if (isSampleSlip(fp)) return { result: 'invalid', reason: 'เป็นภาพตัวอย่างสลิปจาก Option Pay ไม่ใช่สลิปจริง', fp };
  const v = await verifySlip(buf, mime);
  // "No QR" from the provider: say what the image actually has (a fake QR, or a QR that isn't a slip's).
  if (v.verified === false) return { result: 'invalid', reason: (/QR/.test(v.message ?? '') && qrReason(fp)) || v.message || 'สลิปไม่ถูกต้อง', fp };
  if (v.verified !== true) return { result: 'unverified', reason: v.message ?? 'ผู้ให้บริการตรวจสลิปไม่ตอบ', fp };
  const cmp = expect ? compare(v, expect) : { problems: [], notes: [], matched: [] };
  if (cmp.problems.length) return { result: 'invalid', reason: 'ข้อมูลในสลิปไม่ตรงกับที่ต้องชำระ', problems: cmp.problems, fp, v };
  const dup = await seenBefore({ transRef: v.transRef, sha256: fp.sha256, qr: fp.qr }, expect?.kind === 'order' ? expect.order.id : null, recheck);
  if (dup) return { result: 'invalid', reason: dup.reason, detail: dup.detail, fp, v };
  return { result: 'valid', fp, v, matched: cmp.matched, notes: cmp.notes, order: expect?.kind === 'order' ? expect.order : null };
}

function replyText(r) {
  if (r.result === 'valid') {
    const d = r.v.raw ?? {};
    const name = (x) => x?.account?.name?.th || x?.account?.name?.en || x?.displayName || '-';
    const acct = (x) => x?.account?.bank?.account || x?.account?.value || x?.account?.proxy?.account || '';
    return ['✅ valid slip', '',
      `ยอด ${baht(r.v.amount)}`,
      `จาก ${name(d.sender)} ${d.sender?.bank?.short ?? ''} ${acct(d.sender)}`.trim(),
      `ถึง ${name(d.receiver)} ${d.receiver?.bank?.short ?? ''} ${acct(d.receiver)}`.trim(),
      r.v.date ? `เวลาโอน ${when(r.v.date)}` : null,
      r.v.transRef ? `เลขอ้างอิง ${r.v.transRef}` : null,
      r.order ? `\nตรงกับรายการ ${r.order.ref}${r.order.merchant_order_id ? ` (เลขออเดอร์ ${r.order.merchant_order_id})` : ''}` : null,
      r.matched?.length ? `✔️ ตรงกับที่ระบุ: ${r.matched.join(' · ')}` : null,
      r.notes?.length ? `⚠️ ${r.notes.join(' · ')}` : null].filter((x) => x !== null).join('\n');
  }
  if (r.result === 'invalid') return `❌ invalid slip\n\nเหตุผล: ${r.reason}${r.problems?.length ? `\n${r.problems.map((x) => `• ${x}`).join('\n')}` : ''}${r.detail ? `\n\n${r.detail}` : ''}`;
  return `⚠️ ตรวจสลิปไม่ได้ในขณะนี้ (ไม่ใช่ว่าสลิปไม่ถูกต้อง)\n\nสาเหตุ: ${r.reason}\nลองส่งใหม่อีกครั้งภายหลัง`;
}

// Words printed on Thai bank slips: a group photo whose QR can't be read still counts as a slip
// (e.g. a fake slip) when its text has at least two of these.
const SLIP_WORDS = [/โอนเงินสำเร็จ|เติมเงินสำเร็จ|ชำระเงินสำเร็จ|รายการสำเร็จ|ทำรายการสำเร็จ/, /จำนวนเงิน|จำนวน:/, /บาท|thb/i, /รหัสอ้างอิง|เลขที่รายการ|เลขอ้างอิง|ref/i,
  /จาก|ไปยัง|ผู้รับ|ผู้โอน/, /ธนาคาร|scb|kbank|k\+|กสิกร|กรุงเทพ|กรุงไทย|กรุงศรี|ทหารไทย|ttb|ออมสิน|พร้อมเพย์|promptpay/i];
async function looksLikeSlip(buf) {
  try {
    const text = (await readSlipText(buf)).replace(/\u0e4d\u0e32/g, 'ำ');
    return SLIP_WORDS.filter((re) => re.test(text)).length >= 2;
  } catch {
    return false;
  }
}

const HELP = 'ส่งรูปสลิปโอนเงินมาที่นี่ — บอทจะถามรายการที่ต้องชำระ (เลขที่รายการ หรือ ยอด/บัญชีปลายทาง) แล้วตรวจกับธนาคาร (EasySlip) และตอบว่า valid slip หรือ invalid slip พร้อมเหตุผล\n\nแนะนำ: ส่งแบบ “ไฟล์” (File) จะชัดกว่าส่งแบบรูปภาพที่ Telegram บีบอัด';

/** Handle one Telegram update (called after the webhook has answered 200). */
// ---------- asking for the expected payment before verifying ----------

const SESSION_MIN = 10;
const ASK = {
  ref: 'ก่อนตรวจสลิป กรุณาระบุรายการที่ต้องชำระ 🧾\n\nพิมพ์ “เลขที่รายการ” (ขึ้นต้นด้วย TXN) หรือ “เลขออเดอร์ของร้าน”\nถ้าไม่มี พิมพ์ “ไม่มี” แล้วบอทจะถามรายละเอียดทีละข้อ\n(พิมพ์ “ยกเลิก” เพื่อยกเลิก)',
  amount: 'ข้อ 1/4 — ยอดเงินที่ต้องโอนกี่บาท? (เช่น 3000 หรือ 1,250.50)',
  account: 'ข้อ 2/4 — เลขบัญชีปลายทาง หรือเบอร์พร้อมเพย์ ที่ต้องโอนเข้า?',
  name: 'ข้อ 3/4 — ชื่อบัญชีปลายทาง?',
  sender: 'ข้อ 4/4 — ชื่อบัญชีผู้โอน? (ถ้าไม่ต้องการตรวจ พิมพ์ “ข้าม”)',
  recheck: 'ต้องการตรวจสลิปนี้ใหม่หรือไม่?\nพิมพ์ “ใช่” เพื่อตรวจใหม่ หรือ “ไม่” เพื่อใช้ผลเดิม',
};
const NEXT = { amount: 'account', account: 'name', name: 'sender' };

const getSession = async (chatId, userId) => (await query(`SELECT * FROM telegram_slip_sessions WHERE chat_id = $1 AND user_id = $2 AND expires_at > now()`, [chatId, userId])).rows[0] ?? null;
const saveSession = (chatId, userId, f) => query(
  `INSERT INTO telegram_slip_sessions (chat_id, user_id, file_id, mime, message_id, step, data, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => ${SESSION_MIN}))
   ON CONFLICT (chat_id, user_id) DO UPDATE SET file_id = EXCLUDED.file_id, mime = EXCLUDED.mime, message_id = EXCLUDED.message_id, step = EXCLUDED.step, data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
  [chatId, userId, f.file_id, f.mime, f.message_id, f.step, JSON.stringify(f.data ?? {})],
);
const endSession = (chatId, userId) => query('DELETE FROM telegram_slip_sessions WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);

/** An Option Pay order by TXN ref or the shop's Order ID (with its receiving account). */
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
      WHERE result IN ('valid', 'invalid') AND (image_sha256 = $1 OR ($2::text IS NOT NULL AND qr_payload = $2))
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

/** One answer in an open conversation. Returns the bot's reply. */
async function answer(cfg, chatId, userId, sess, text, who) {
  const t = text.trim();
  if (/^(ยกเลิก|cancel)$/i.test(t)) { await endSession(chatId, userId); return 'ยกเลิกการตรวจสลิปแล้ว'; }
  const data = sess.data ?? {};
  const again = (msg) => saveSession(chatId, userId, { ...sess, data }).then(() => msg);
  switch (sess.step) {
    case 'recheck': {
      if (/^(ใช่|ตรวจใหม่|yes|y)$/i.test(t)) { await saveSession(chatId, userId, { ...sess, step: 'ref', data: { recheck: true } }); return ASK.ref; }
      if (/^(ไม่|ไม่ต้อง|no|n)$/i.test(t)) { await endSession(chatId, userId); return 'ไม่ตรวจซ้ำ — ใช้ผลการตรวจเดิม'; }
      return again(`กรุณาพิมพ์ “ใช่” หรือ “ไม่”\n\n${ASK.recheck}`);
    }
    case 'ref': {
      if (/^(ไม่มี|ไม่ทราบ|no|none|-)$/i.test(t)) {
        // Check the slip with the bank once, now: a fake / duplicate slip fails before any question,
        // and every answer below is compared on the spot — the first mismatch ends the questions.
        const r = await runCheck(cfg, sess, null);
        if (r.result !== 'valid') return finish(chatId, userId, sess, r, who);
        const { provider, raw, amount, transRef, date } = r.v;
        await saveSession(chatId, userId, { ...sess, step: 'amount', data: { recheck: !!data.recheck, v: { provider, raw, amount, transRef, date }, fp: { sha256: r.fp.sha256, qr: r.fp.qr }, matched: [], notes: [] } });
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
  const send = (text) => tg(cfg.botToken, 'sendMessage', { chat_id: msg.chat.id, text, reply_to_message_id: msg.message_id }).catch(() => {});
  const allowed = cfg.allowedChatIds.split(',').map((x) => x.trim()).filter(Boolean);
  if (!allowed.includes(chatId) && !(inGroup ? cfg.allGroups !== false : cfg.allowPrivate !== false)) {
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('telegram', 'slipbot.denied', 'setting', $1, $2)`,
      [chatId, `แชทที่ยังไม่ได้รับอนุญาตใช้บอทตรวจสลิป: ${msg.chat.title ?? msg.from?.username ?? msg.from?.first_name ?? ''}`]).catch(() => {});
    await send(`บอทนี้ยังไม่ได้เปิดให้แชทนี้ใช้งาน\nchat id: ${chatId}\nแจ้งผู้ดูแลระบบ Option Pay เพื่อเพิ่ม chat id นี้`);
    return;
  }
  if (sess) { await send(await answer(cfg, chatId, userId, sess, msg.text, who)); return; }
  if (!img) { await send(HELP); return; }
  if (img.size && img.size > MAX_BYTES) { await send('❌ invalid slip\n\nเหตุผล: ไฟล์ใหญ่เกิน 8 MB'); return; }
  try {
    const buf = await download(cfg.botToken, img.fileId);
    const fp = slipFingerprint(buf, img.mime);
    // Group photos without a readable QR code are ordinary pictures — ignored (no reply, no EasySlip quota) —
    // unless the caption says it is a slip or the printed text looks like one (OCR, no quota).
    if (inGroup && !fp.qr && !/สลิป|slip/i.test(msg.caption ?? '') && !(await looksLikeSlip(buf))) return;
    const prior = await priorResult(fp);
    if (prior) {
      await saveSession(chatId, userId, { file_id: img.fileId, mime: img.mime, message_id: msg.message_id, step: 'recheck', data: {} });
      await send(`${prior}\n\n${ASK.recheck}`);
      return;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'slip bot: download failed');
  }
  // Ask what the slip should match first; EasySlip is called only once the answers are in.
  await saveSession(chatId, userId, { file_id: img.fileId, mime: img.mime, message_id: msg.message_id, step: 'ref', data: {} });
  await send(ASK.ref);
}
