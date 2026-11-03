/**
 * Slips attached to FINISHED orders (approved / refunded / rejected outside the late-slip window) — user, 2 Nov 2026,
 * after TXN222101: an admin replaced the verified slip of an approved order with another customer's 300-baht slip; the
 * image was stored without any check, and that customer's own order (TXN222010) could then no longer take its slip.
 *
 *   1. LOCK — an approved / refunded order whose slip was accepted (checked and passed) keeps that slip: refused.
 *   2. CHECK — any other slip on a finished order is checked with the bank first: the amount must be the order's, the
 *      transfer must not be older than the order or already have paid another order, and the image must not be another
 *      order's slip (the sender's name is shown, not compared — Thai vs English names, someone else may pay). A refusal names the open / cancelled order it most likely
 *      belongs to.
 *   3. HISTORY — every attempt is kept (payment_slip_history + the image file), refused ones included; the order's
 *      official slip (payment_slips) is never overwritten by a refused one, and evidence never blocks another order.
 *   5. ALERT — every slip attached to, or refused on, a finished order goes to the alert bots subscribed to
 *      'payment.slip_change' (the "Option Pay Controller" group) with the order's slip and the new one side by side.
 * (4 — the confirm step — is in the console's attach dialog.)
 */
import { query, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, BadRequestError } from '../errors.js';
import logger from '../logger.js';
import { findReusedSlip, isSampleSlip, SAMPLE_SLIP_MESSAGE, slipFingerprint } from '../shared/slip-fingerprint.js';
import { dbCopyOf, readSlipFile, saveSlipFile, slipImage } from '../shared/slip-store.js';
import { verifySlip } from '../merchant-api/slip-verify.js';
import { nameMatches, normalizeSlip } from '../merchant-api/slip-match.js';
import { sendAlertMedia } from '../alerts/alert.service.js';

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thTime = (d) => (d ? new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'medium' }) : '—');
const STATUS_TH = { approved: 'อนุมัติแล้ว', refunded: 'คืนเงินแล้ว', rejected: 'ยกเลิก/ปฏิเสธ', expired: 'หมดอายุ', pending: 'รอชำระ' };
const EARLY_MS = 60 * 60_000;   // a transfer more than 1 h before the order was made cannot be for it

/** The order's slip was accepted: checked and passed (or approved), or stored as checked evidence. */
export function isAcceptedSlip(slip) {
  if (!slip) return false;
  const vr = slip.verify_result ?? {};
  return vr.decision === 'approve' || vr.decision === 'evidence' || vr.verified === true || !!slip.trans_ref;
}

/** One history row (any outcome). `c` = a client in a transaction, or the pool. */
export function recordSlipHistory(c, row) {
  return c.query(
    `INSERT INTO payment_slip_history (payment_id, uploaded_by, outcome, reason, mime, file_path, image_sha256, qr_payload, slip_amount, slip_date, slip_ref, slip_sender)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [row.paymentId, row.by ?? null, row.outcome, row.reason ? String(row.reason).slice(0, 1000) : null, row.mime ?? null, row.file ?? null,
      row.sha256 ?? null, row.qr ?? null, Number.isFinite(row.amount) ? row.amount : null, row.date ? new Date(row.date) : null,
      row.transRef ?? null, row.sender ?? null],
  ).catch((err) => logger.warn({ err, paymentId: row.paymentId }, 'slip history not written'));
}

/** Open / expired / cancelled orders (any shop) this transfer most likely belongs to — same amount, made shortly before it. */
async function likelyOwners(paymentId, amount, date, senderNames) {
  if (!Number.isFinite(amount)) return [];
  const at = date ? new Date(date) : new Date();
  const { rows } = await query(
    `SELECT p.ref, p.customer_name, p.amount, p.status, p.created_at, m.name AS merchant_name FROM payments p LEFT JOIN merchants m ON m.id = p.merchant_id
      WHERE p.id <> $1 AND p.deleted_at IS NULL AND p.status IN ('pending', 'expired', 'rejected')
        AND (p.amount = $2 OR p.requested_amount = $2)
        AND p.created_at BETWEEN $3::timestamptz - interval '48 hours' AND $3::timestamptz + interval '15 minutes'
        AND NOT EXISTS (SELECT 1 FROM slip_transfer_uses u WHERE u.payment_id = p.id)
      ORDER BY abs(extract(epoch FROM (p.created_at - $3::timestamptz))) LIMIT 20`,
    [paymentId, amount, at],
  );
  const named = senderNames?.length ? rows.filter((r) => nameMatches(senderNames, r.customer_name) === true) : [];
  if (named.length) return named.slice(0, 3);
  // Names often can't be compared (English on the slip, Thai on the order): orders made shortly before the transfer.
  const t = at.getTime();
  return rows.filter((r) => { const c = new Date(r.created_at).getTime(); return c <= t + 2 * 60_000 && c >= t - 30 * 60_000; }).slice(0, 3);
}

/** Telegram (best effort, after the decision): the order's slip and the new one, side by side. */
async function alertSlipChange(p, { stored, reason, by, newBytes, newMime, v, sender, owners }) {
  try {
    const lines = [
      `${stored ? '⚠️ แนบสลิปกับรายการที่ปิดแล้ว — บันทึกเป็นหลักฐาน (ตรวจกับธนาคารแล้ว ยอดตรง)' : '⛔ ปฏิเสธการแนบสลิปกับรายการที่ปิดแล้ว — รายการยังใช้สลิปเดิม'}`,
      `รายการ: ${p.ref}${p.merchant_order_id ? ` (${p.merchant_order_id})` : ''} · ร้าน ${p.merchant_name ?? 'house'}`,
      `ลูกค้า: ${p.customer_name ?? '—'} · ยอด ${fmt(p.amount)} บาท · สถานะ ${STATUS_TH[p.status] ?? p.status}`,
      `ผู้แนบ: ${by ?? 'console'} · เวลา ${thTime(new Date())}`,
      v?.verified === true
        ? `สลิปที่แนบ: ยอด ${fmt(v.amount)} บาท${sender ? ` · ผู้โอน ${sender}` : ''} · โอน ${thTime(v.date)}${v.transRef ? ` · เลขอ้างอิง ${v.transRef}` : ''}`
        : 'สลิปที่แนบ: ตรวจกับธนาคารไม่ได้ / ไม่ได้ตรวจ',
      reason ? `${stored ? 'หมายเหตุ' : 'เหตุผล'}: ${reason}` : null,
      owners?.length ? `สลิปนี้น่าจะเป็นของ: ${owners.map((o) => `${o.ref} (${o.customer_name ?? '—'} ${fmt(o.amount)} บาท · ${o.merchant_name ?? 'house'})`).join(', ')}` : null,
      p.slip_file || p.has_slip ? 'ภาพ: 1) สลิปเดิมของรายการ · 2) สลิปที่แนบ' : 'ภาพ: สลิปที่แนบ (รายการนี้ยังไม่มีสลิปเดิม)',
    ].filter(Boolean);
    const photos = [];
    if (p.has_slip) {
      const old = await slipImage('payment_slips', p.id, p.slip_file).catch(() => null);
      if (old) photos.push({ bytes: old, mime: p.slip_mime ?? 'image/jpeg', caption: `สลิปเดิมของ ${p.ref}` });
    }
    if (newBytes) photos.push({ bytes: newBytes, mime: newMime, caption: stored ? `สลิปที่แนบ (บันทึกแล้ว) — ${p.ref}` : `สลิปที่ถูกปฏิเสธ — ${p.ref}` });
    await sendAlertMedia('payment.slip_change', lines.join('\n'), photos, { merchantId: p.merchant_id });
  } catch (err) {
    logger.warn({ err, ref: p.ref }, 'slip change alert not sent');
  }
}

/**
 * Admin "แนบสลิป" on an order the automatic check does not handle (finished orders). Throws ConflictError (409) with
 * details { code, owners } when refused; returns { stored: true, message } when the slip was kept as evidence.
 */
export async function attachEvidenceSlip(ref, actor, { mime, data }) {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 5 * 1024 * 1024) throw new BadRequestError('Slip image must be 5 MB or smaller');
  const fp = await slipFingerprint(bytes, mime);
  if (isSampleSlip(fp)) throw new BadRequestError(SAMPLE_SLIP_MESSAGE);
  const { rows: [p] } = await query(
    `SELECT p.*, m.name AS merchant_name, (s.payment_id IS NOT NULL) AS has_slip, s.verify_result, s.trans_ref, s.file_path AS slip_file, s.mime AS slip_mime
       FROM payments p LEFT JOIN merchants m ON m.id = p.merchant_id LEFT JOIN payment_slips s ON s.payment_id = p.id
      WHERE p.ref = $1 AND p.deleted_at IS NULL`,
    [ref],
  );
  if (!p) throw new NotFoundError('ไม่พบรายการ');
  // The image is kept as a file whatever happens (history + the alert can show it).
  const file = await saveSlipFile('payment', bytes, mime, fp.sha256);
  const base = { paymentId: p.id, by: actor, mime, file, sha256: fp.sha256, qr: fp.qr };
  let v = null; let sender = null;
  const refuse = async (code, text, owners = []) => {
    await recordSlipHistory({ query }, { ...base, outcome: 'refused', reason: text, amount: v?.verified ? Number(v.amount) : null, date: v?.verified ? v.date : null, transRef: v?.transRef ?? null, sender });
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'payment.slip_refused', 'payment', $2, $3)`, [actor ?? 'console', ref, `ไม่รับสลิป (รายการ${STATUS_TH[p.status] ?? p.status}) — ${text}`.slice(0, 1000)]);
    alertSlipChange(p, { stored: false, reason: text, by: actor, newBytes: bytes, newMime: mime, v, sender, owners });
    throw new ConflictError(text, { code, owners: owners.map((o) => o.ref) });
  };

  // 1. The accepted slip of an approved / refunded order stays.
  if (['approved', 'refunded'].includes(p.status) && p.has_slip && isAcceptedSlip(p)) {
    return refuse('SLIP_LOCKED', `รายการ ${ref} ${STATUS_TH[p.status]}ด้วยสลิปที่ตรวจผ่านแล้ว — เปลี่ยนหรือแนบสลิปใหม่ไม่ได้ · ถ้าสลิปนี้เป็นของลูกค้าคนอื่น ให้แนบที่รายการของลูกค้าคนนั้น`);
  }

  // 2. Checked with the bank: it has to be THIS order's transfer.
  v = await verifySlip(bytes, mime, { pendingRetries: false, purpose: 'slip_evidence' });
  if (v.verified === false) return refuse('SLIP_INVALID', `ตรวจกับธนาคารไม่ผ่าน — ${v.message}`);
  if (v.verified !== true) return refuse('SLIP_UNCHECKED', `ตรวจสลิปกับธนาคารไม่ได้ตอนนี้ (${v.message ?? 'ไม่มีคำตอบ'}) — สลิปของรายการที่ปิดแล้วต้องตรวจผ่านก่อนจึงจะบันทึกได้ ลองใหม่อีกครั้งภายหลัง`);
  const slip = normalizeSlip(v.provider, v.raw);
  sender = slip?.senderNames?.[0] ?? null;
  const amount = Number(v.amount);
  const problems = [];
  const wants = [Number(p.amount), Number(p.requested_amount ?? p.amount)];
  if (!wants.some((w) => Math.abs(w - amount) < 0.005)) problems.push(`ยอดในสลิป ${fmt(amount)} บาท ไม่ตรงกับยอดของรายการ ${fmt(p.amount)} บาท`);
  // The sender's name is NOT a reason to refuse: providers often give only the English name ("MRS BENYATHIP R") while
  // customers are kept in Thai, and someone else may pay for a customer (the automatic check allows it too). It is shown.
  if (v.date && new Date(v.date).getTime() < new Date(p.created_at).getTime() - EARLY_MS) problems.push(`โอนเมื่อ ${thTime(v.date)} — ก่อนสร้างรายการนี้ (${thTime(p.created_at)})`);
  if (v.transRef) {
    const { rows } = await query(
      `SELECT p.ref FROM slip_transfers t JOIN slip_transfer_uses u ON u.transfer_id = t.id JOIN payments p ON p.id = u.payment_id
        WHERE t.trans_ref = $1 AND p.id <> $2 LIMIT 1`, [v.transRef, p.id]);
    if (rows[0]) problems.push(`การโอนนี้ใช้ชำระรายการ ${rows[0].ref} แล้ว`);
  }
  if (problems.length) {
    const owners = await likelyOwners(p.id, amount, v.date, slip?.senderNames);
    const hint = owners.length ? ` · สลิปนี้น่าจะเป็นของ ${owners.map((o) => `${o.ref} (${o.customer_name ?? '—'} ${fmt(o.amount)} บาท)`).join(', ')} — แนบที่รายการนั้นแทน` : '';
    return refuse('SLIP_NOT_THIS_ORDER', `สลิปนี้ไม่ใช่ของรายการ ${ref}: ${problems.join(' · ')}${hint}`, owners);
  }

  // 3. Stored as the order's evidence (it changes nothing else), and in the history.
  const message = `แนบเป็นหลักฐาน (รายการ${STATUS_TH[p.status] ?? p.status}) — ตรวจกับ ${v.provider} แล้ว ยอด ${fmt(amount)} บาท ตรงกับรายการ`;
  let reusedOn = null;
  await withTransaction(async (c) => {
    const { rows: [cur] } = await c.query(
      `SELECT p.status, s.verify_result, s.trans_ref, (s.payment_id IS NOT NULL) AS has_slip FROM payments p LEFT JOIN payment_slips s ON s.payment_id = p.id WHERE p.id = $1 FOR UPDATE OF p`, [p.id]);
    if (['approved', 'refunded'].includes(cur.status) && cur.has_slip && isAcceptedSlip(cur)) { reusedOn = 'LOCKED'; return; }
    reusedOn = await findReusedSlip(c, p.id, fp);
    if (reusedOn) return;
    await c.query(
      `INSERT INTO payment_slips (payment_id, mime, data, uploaded_by, provider, verify_result, image_sha256, qr_payload, file_path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (payment_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now(), provider = EXCLUDED.provider,
         trans_ref = NULL, verify_result = EXCLUDED.verify_result, image_sha256 = EXCLUDED.image_sha256, qr_payload = EXCLUDED.qr_payload, file_path = EXCLUDED.file_path,
         recheck_at = NULL, recheck_attempts = 0`,
      [p.id, mime, await dbCopyOf(bytes, file), actor, v.provider,
        JSON.stringify({ decision: 'evidence', verified: true, amount, date: v.date ?? null, transRef: v.transRef ?? null, sender, message }), fp.sha256, fp.qr, file],
    );
    await c.query('UPDATE payments SET slip_received_at = coalesce(slip_received_at, now()) WHERE id = $1', [p.id]);
    await recordSlipHistory(c, { ...base, outcome: 'evidence', reason: message, amount, date: v.date, transRef: v.transRef, sender });
    await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'payment.slip', 'payment', $2, $3)`, [actor ?? 'console', ref, `แนบสลิป · ${message}`]);
  });
  if (reusedOn === 'LOCKED') return refuse('SLIP_LOCKED', `รายการ ${ref} มีสลิปที่ตรวจผ่านแล้ว — เปลี่ยนหรือแนบสลิปใหม่ไม่ได้`);
  if (reusedOn) return refuse('SLIP_ALREADY_USED', `สลิปนี้ถูกใช้แล้วกับรายการ ${reusedOn} — ใช้ซ้ำกับรายการอื่นไม่ได้`);
  alertSlipChange(p, { stored: true, reason: message, by: actor, newBytes: bytes, newMime: mime, v, sender });
  return { stored: true, message };
}

/** Every slip attached to an order, newest first (the console's slip dialog). */
export async function slipHistory(ref) {
  const { rows } = await query(
    `SELECT h.id, h.uploaded_at AS "uploadedAt", h.uploaded_by AS "uploadedBy", h.outcome, h.reason, h.slip_amount AS "slipAmount",
            h.slip_date AS "slipDate", h.slip_ref AS "slipRef", h.slip_sender AS "slipSender", (h.file_path IS NOT NULL) AS "hasImage",
            (s.payment_id IS NOT NULL AND h.image_sha256 IS NOT DISTINCT FROM s.image_sha256) AS current
       FROM payment_slip_history h JOIN payments p ON p.id = h.payment_id LEFT JOIN payment_slips s ON s.payment_id = p.id
      WHERE p.ref = $1 ORDER BY h.uploaded_at DESC, h.id DESC`,
    [ref],
  );
  return { history: rows };
}

/** The image of one history entry. */
export async function slipHistoryImage(ref, id) {
  const { rows: [h] } = await query(
    `SELECT h.mime, h.file_path FROM payment_slip_history h JOIN payments p ON p.id = h.payment_id WHERE p.ref = $1 AND h.id = $2`, [ref, id]);
  const data = h?.file_path ? await readSlipFile(h.file_path) : null;
  if (!data) throw new NotFoundError('ไม่พบภาพสลิปนี้');
  return { mime: h.mime ?? 'image/jpeg', data };
}
