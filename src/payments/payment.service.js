import { query, withTransaction } from '../db/pool.js';
import { notifyPaymentApproved } from '../config-admin/config.service.js';
import logger from '../logger.js';
import { deliverPaymentEvent } from '../webhooks/webhook.service.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { findReusedSlip, isSampleSlip, SAMPLE_SLIP_MESSAGE, slipFingerprint } from '../shared/slip-fingerprint.js';

/**
 * Operator actions on payments. Each runs in one transaction: lock the row,
 * check the transition is allowed, update, and write an audit_logs entry.
 */

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function lock(client, ref) {
  const { rows } = await client.query(
    `SELECT p.id, p.ref, p.status, p.amount, p.merchant_id, p.refunded_amount,
            m.fee_percent, m.fee_flat
       FROM payments p LEFT JOIN merchants m ON m.id = p.merchant_id
      WHERE p.ref = $1
      FOR UPDATE OF p`,
    [ref],
  );
  if (!rows[0]) throw new NotFoundError(`Payment ${ref} does not exist`);
  return rows[0];
}

function requireStatus(p, allowed, verb) {
  if (!allowed.includes(p.status)) {
    throw new ConflictError(`Cannot ${verb} ${p.ref}: status is ${p.status}`, { status: p.status, allowed });
  }
}

const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'payment', $3, $4)`, [
    actor ?? 'console',
    action,
    ref,
    detail,
  ]);

/** Fee for an amount under the payment's merchant (house payments pay none). */
function feeFor(p, amount) {
  if (p.merchant_id == null) return { fee: 0, commission: 0 };
  const fee = Math.round(((amount * Number(p.fee_percent)) / 100 + Number(p.fee_flat)) * 100) / 100;
  return { fee, commission: Math.round(fee * 0.05 * 100) / 100 };
}

/** Merchant webhooks for a committed payment change; never throws. */
export const emitPaymentEvent = (client, ref, event) =>
  client.afterCommit?.(() => deliverPaymentEvent(ref, event).catch((err) => logger.warn({ err, ref, event }, 'merchant webhook failed')));

export async function approveOne(client, ref, actor, note) {
  const p = await lock(client, ref);
  requireStatus(p, ['pending', 'expired'], 'approve');
  await client.query(
    `UPDATE payments SET status = 'approved', reviewed_by = $2, completed_at = now(), review_note = coalesce($3, review_note) WHERE id = $1`,
    [p.id, actor, note ?? null],
  );
  await audit(client, actor, 'payment.approve', ref, `ยอด ${fmt(p.amount)} บาท`);
  client.afterCommit?.(() => notifyPaymentApproved({ ref, merchantId: p.merchant_id, merchantOrderId: p.merchant_order_id, amount: p.amount, approvedBy: actor }));
  emitPaymentEvent(client, ref, 'payment.approved');
}

async function rejectOne(client, ref, actor, reason) {
  const p = await lock(client, ref);
  requireStatus(p, ['pending', 'expired'], 'reject');
  await client.query(`UPDATE payments SET status = 'rejected', reviewed_by = $2, completed_at = now(), review_note = $3 WHERE id = $1`, [
    p.id,
    actor,
    reason,
  ]);
  await audit(client, actor, 'payment.reject', ref, reason);
  emitPaymentEvent(client, ref, 'payment.rejected');
}

export const approve = (ref, actor, note) => withTransaction((c) => approveOne(c, ref, actor, note));
export const reject = (ref, actor, reason) => withTransaction((c) => rejectOne(c, ref, actor, reason));

export function refund(ref, actor, { amount, note }) {
  return withTransaction(async (client) => {
    const p = await lock(client, ref);
    requireStatus(p, ['approved'], 'refund');
    const value = amount ?? Number(p.amount);
    if (value > Number(p.amount)) throw new BadRequestError('Refund exceeds the payment amount');
    await client.query(
      `UPDATE payments SET status = 'refunded', refunded_amount = $2, completed_at = now(), review_note = coalesce($3, review_note) WHERE id = $1`,
      [p.id, value, note ?? null],
    );
    await audit(client, actor, 'payment.refund', ref, `คืนเงิน ${fmt(value)} บาท`);
  });
}

export function editAmount(ref, actor, amount) {
  return withTransaction(async (client) => {
    const p = await lock(client, ref);
    requireStatus(p, ['pending', 'expired'], 'edit the amount of');
    const { fee, commission } = feeFor(p, amount);
    await client.query(`UPDATE payments SET amount = $2, fee = $3, commission = $4 WHERE id = $1`, [p.id, amount, fee, commission]);
    await audit(client, actor, 'payment.amount', ref, `แก้ยอด ${fmt(p.amount)} → ${fmt(amount)} บาท`);
  });
}

export function revive(ref, actor) {
  return withTransaction(async (client) => {
    const p = await lock(client, ref);
    requireStatus(p, ['expired'], 'revive');
    await client.query(`UPDATE payments SET status = 'pending', completed_at = NULL WHERE id = $1`, [p.id]);
    await audit(client, actor, 'payment.revive', ref, 'ปลุกคืนออเดอร์ที่หมดอายุ');
  });
}

export function remove(ref, actor) {
  return withTransaction(async (client) => {
    const p = await lock(client, ref);
    // Money that moved stays on record: only unpaid / closed-without-refund rows go.
    requireStatus(p, ['pending', 'expired', 'rejected'], 'delete');
    if (Number(p.refunded_amount) > 0) throw new ConflictError(`Cannot delete ${ref}: it has a refund`);
    await client.query('DELETE FROM payments WHERE id = $1', [p.id]);
    await audit(client, actor, 'payment.delete', ref, `ลบรายการ ยอด ${fmt(p.amount)} บาท`);
  });
}

/** All-or-nothing: if any ref cannot move, none do. */
export function bulk(actor, { action, refs, reason }) {
  return withTransaction(async (client) => {
    for (const ref of [...new Set(refs)]) {
      if (action === 'approve') await approveOne(client, ref, actor);
      else await rejectOne(client, ref, actor, reason);
    }
    return { count: new Set(refs).size };
  });
}

export function create(actor, input) {
  return withTransaction(async (client) => {
    const { rows: acct } = await client.query(
      `SELECT id FROM bank_accounts WHERE id = $1 AND status = 'active' AND account_type <> 'send'`,
      [input.bankAccountId],
    );
    if (!acct[0]) throw new BadRequestError('Receiving account must be active and able to receive');
    let merchant = { merchant_id: null };
    if (input.merchantId != null) {
      const { rows } = await client.query('SELECT id AS merchant_id, fee_percent, fee_flat, status FROM merchants WHERE id = $1', [input.merchantId]);
      if (!rows[0]) throw new BadRequestError('Unknown merchant');
      if (rows[0].status !== 'active') throw new BadRequestError('Merchant is not active');
      merchant = rows[0];
    }
    const { fee, commission } = feeFor(merchant, input.amount);
    // Running number after the highest existing TXN ref; the row lock on the
    // table's newest ref keeps two creates from taking the same number.
    await client.query('LOCK TABLE payments IN SHARE ROW EXCLUSIVE MODE');
    const { rows: last } = await client.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 172800) AS n FROM payments WHERE ref ~ '^TXN[0-9]+$'`);
    const ref = `TXN${Number(last[0].n) + 1}`;
    await client.query(
      `INSERT INTO payments (ref, merchant_id, merchant_order_id, customer_name, payer_bank_code, bank_account_id, amount, fee, commission, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [ref, input.merchantId, input.merchantOrderId || null, input.customerName, input.payerBankCode, input.bankAccountId, input.amount, fee, commission],
    );
    await audit(client, actor, 'payment.create', ref, `สร้างรายการ ยอด ${fmt(input.amount)} บาท`);
    return { ref };
  });
}

export function assignMerchant(ref, actor, { merchantId, merchantOrderId }) {
  return withTransaction(async (client) => {
    const p = await lock(client, ref);
    requireStatus(p, ['pending', 'expired'], 'reassign');
    let merchant = { merchant_id: null };
    if (merchantId != null) {
      const { rows } = await client.query('SELECT id AS merchant_id, name, fee_percent, fee_flat FROM merchants WHERE id = $1', [merchantId]);
      if (!rows[0]) throw new BadRequestError('Unknown merchant');
      merchant = rows[0];
    }
    const { fee, commission } = feeFor(merchant, Number(p.amount));
    await client.query(
      `UPDATE payments SET merchant_id = $2, merchant_order_id = coalesce(nullif($3, ''), merchant_order_id), fee = $4, commission = $5 WHERE id = $1`,
      [p.id, merchantId, merchantOrderId ?? null, fee, commission],
    );
    await audit(client, actor, 'payment.assign', ref, merchant.name ? `ระบุร้าน: ${merchant.name}` : 'ไม่ผูกร้าน (house)');
  });
}

export function uploadSlip(ref, actor, { mime, data }) {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 5 * 1024 * 1024) throw new BadRequestError('Slip image must be 5 MB or smaller');
  const fp = slipFingerprint(bytes, mime);
  if (isSampleSlip(fp)) throw new BadRequestError(SAMPLE_SLIP_MESSAGE);
  return withTransaction(async (client) => {
    const p = await lock(client, ref);
    // One transfer pays one order, admin uploads included.
    const reusedOn = await findReusedSlip(client, p.id, fp);
    if (reusedOn) throw new ConflictError(`สลิปนี้ถูกใช้แล้วกับรายการ ${reusedOn} — ใช้ซ้ำกับรายการอื่นไม่ได้`, { code: 'SLIP_ALREADY_USED', reusedOn });
    await client.query(
      `INSERT INTO payment_slips (payment_id, mime, data, uploaded_by, image_sha256, qr_payload) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (payment_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now(),
         image_sha256 = EXCLUDED.image_sha256, qr_payload = EXCLUDED.qr_payload, verify_result = NULL`,
      [p.id, mime, bytes, actor, fp.sha256, fp.qr],
    );
    await client.query('UPDATE payments SET slip_received_at = coalesce(slip_received_at, now()) WHERE id = $1', [p.id]);
    await audit(client, actor, 'payment.slip', ref, 'แนบสลิป');
  });
}

export async function getSlip(ref) {
  const { rows } = await query(
    `SELECT s.mime, s.data FROM payment_slips s JOIN payments p ON p.id = s.payment_id WHERE p.ref = $1`,
    [ref],
  );
  if (!rows[0]) throw new NotFoundError(`No slip for ${ref}`);
  return rows[0];
}
