import { timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { internal as configOf } from '../config-admin/config.service.js';
import logger from '../logger.js';
import { verifySlip } from '../merchant-api/slip-verify.js';
import { isSampleSlip, slipFingerprint } from '../shared/slip-fingerprint.js';

/**
 * @OptionPayBot: a user sends a slip image; the bot asks the slip provider (EasySlip)
 * whether it is a real transfer and replies "valid slip" or "invalid slip" with the reason.
 * A slip already used on an Option Pay order, or already checked here, is a duplicate.
 * Only chats in Settings (slipBot.allowedChatIds) may use it — each check spends quota.
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
    p.merchant_order_id ? `Order ID: ${p.merchant_order_id}` : null,
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
async function seenBefore({ transRef, sha256, qr }) {
  const { rows: onOrder } = await query(
    `SELECT p.id, p.ref, s.uploaded_at FROM payment_slips s JOIN payments p ON p.id = s.payment_id
      WHERE coalesce(s.verify_result->>'decision', '') <> 'invalid'
        AND (($1::text IS NOT NULL AND s.trans_ref = $1) OR s.image_sha256 = $2 OR ($3::text IS NOT NULL AND s.qr_payload = $3))
      ORDER BY s.uploaded_at LIMIT 1`,
    [transRef ?? null, sha256, qr],
  );
  if (onOrder[0]) {
    return { reason: `สลิปนี้ถูกใช้แล้วกับรายการ ${onOrder[0].ref} (เมื่อ ${when(onOrder[0].uploaded_at)})`, detail: await orderDetail(onOrder[0].id) };
  }
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

/** Verify one slip image → { result, reason, details }. */
export async function checkSlip(buf, mime) {
  const fp = slipFingerprint(buf, mime);
  if (isSampleSlip(fp)) return { result: 'invalid', reason: 'เป็นภาพตัวอย่างสลิปจาก Option Pay ไม่ใช่สลิปจริง', fp };
  const v = await verifySlip(buf, mime);
  if (v.verified === false) return { result: 'invalid', reason: v.message ?? 'สลิปไม่ถูกต้อง', fp };
  if (v.verified !== true) return { result: 'unverified', reason: v.message ?? 'ผู้ให้บริการตรวจสลิปไม่ตอบ', fp };
  const dup = await seenBefore({ transRef: v.transRef, sha256: fp.sha256, qr: fp.qr });
  if (dup) return { result: 'invalid', reason: dup.reason, detail: dup.detail, fp, v };
  return { result: 'valid', fp, v };
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
      r.v.transRef ? `เลขอ้างอิง ${r.v.transRef}` : null].filter((x) => x !== null).join('\n');
  }
  if (r.result === 'invalid') return `❌ invalid slip\n\nเหตุผล: ${r.reason}${r.detail ? `\n\n${r.detail}` : ''}`;
  return `⚠️ ตรวจสลิปไม่ได้ในขณะนี้ (ไม่ใช่ว่าสลิปไม่ถูกต้อง)\n\nสาเหตุ: ${r.reason}\nลองส่งใหม่อีกครั้งภายหลัง`;
}

const HELP = 'ส่งรูปสลิปโอนเงินมาที่นี่ — บอทจะตรวจกับธนาคาร (EasySlip) แล้วตอบว่า valid slip หรือ invalid slip พร้อมเหตุผล\n\nแนะนำ: ส่งแบบ “ไฟล์” (File) จะชัดกว่าส่งแบบรูปภาพที่ Telegram บีบอัด';

/** Handle one Telegram update (called after the webhook has answered 200). */
export async function handleUpdate(update) {
  const msg = update?.message;
  if (!msg?.chat) return;
  const cfg = await configOf('slipBot');
  if (!cfg.enabled || !cfg.botToken) return;
  const chatId = String(msg.chat.id);
  const send = (text) => tg(cfg.botToken, 'sendMessage', { chat_id: msg.chat.id, text, reply_to_message_id: msg.message_id }).catch(() => {});
  const allowed = cfg.allowedChatIds.split(',').map((x) => x.trim()).filter(Boolean);
  if (!allowed.includes(chatId)) {
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('telegram', 'slipbot.denied', 'setting', $1, $2)`,
      [chatId, `แชทที่ยังไม่ได้รับอนุญาตใช้บอทตรวจสลิป: ${msg.chat.title ?? msg.from?.username ?? msg.from?.first_name ?? ''}`]).catch(() => {});
    await send(`บอทนี้ยังไม่ได้เปิดให้แชทนี้ใช้งาน\nchat id: ${chatId}\nแจ้งผู้ดูแลระบบ Option Pay เพื่อเพิ่ม chat id นี้`);
    return;
  }
  const img = imageOf(msg);
  if (!img) { await send(HELP); return; }
  if (img.size && img.size > MAX_BYTES) { await send('❌ invalid slip\n\nเหตุผล: ไฟล์ใหญ่เกิน 8 MB'); return; }
  let r;
  try {
    const buf = await download(cfg.botToken, img.fileId);
    r = await checkSlip(buf, img.mime);
  } catch (err) {
    logger.warn({ err: err.message }, 'slip bot: check failed');
    r = { result: 'unverified', reason: 'ดาวน์โหลดหรือตรวจรูปไม่สำเร็จ', fp: {} };
  }
  await query(
    `INSERT INTO telegram_slip_checks (chat_id, message_id, from_user, result, reason, trans_ref, image_sha256, qr_payload, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [chatId, msg.message_id, msg.from?.username ?? msg.from?.first_name ?? null, r.result, r.reason ?? null, r.v?.transRef ?? null, r.fp?.sha256 ?? null, r.fp?.qr ?? null, r.v?.amount ?? null],
  );
  await send(replyText(r));
}
