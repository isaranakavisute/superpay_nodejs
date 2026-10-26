import { z } from 'zod';
import { query } from '../db/pool.js';
import logger from '../logger.js';
import { createPayment, createPaymentSchema, createPayout, payout, payouts } from './v1.service.js';
import { deliverPayoutEvent } from '../webhooks/webhook.service.js';

/**
 * Merchant API v2 — POST /api/v2/payment/create: the v1 order creation, unchanged (it is called as is), plus an
 * optional `return_url`: the shop's page the checkout page (checkoutUrl) sends the customer back to after paying.
 * The v1 endpoint and its code are not touched.
 */
const returnUrl = z.string().trim().max(500).url('return_url ต้องเป็น URL เต็ม เช่น https://your-site.com/deposit/done')
  .refine((u) => u.startsWith('https://'), 'return_url ต้องขึ้นต้นด้วย https://');

export const createPaymentV2Schema = createPaymentSchema.extend({ returnUrl: returnUrl.optional() });

/** return_url (documented) — returnUrl / redirect_url / redirectUrl are accepted as the same field. */
export const withReturnUrl = (b) => (b && typeof b === 'object' && !Array.isArray(b)
  ? { ...b, returnUrl: b.return_url ?? b.returnUrl ?? b.redirect_url ?? b.redirectUrl } : b);

export async function createPaymentV2(m, b, opts) {
  const { returnUrl: url, ...v1Body } = b;
  const out = await createPayment(m, v1Body, opts);   // exactly what POST /api/v1/payment/create does
  if (!url) return out;
  try {
    await query('UPDATE payments SET return_url = $2 WHERE ref = $1', [out.transaction.ref, url]);
    out.transaction.returnUrl = url;
  } catch (err) {
    // The order exists either way; tell the shop the redirect could not be saved rather than fail the call.
    logger.warn({ err: err.message, ref: out.transaction.ref }, 'return_url not saved');
    out.warning = 'สร้างรายการแล้ว แต่บันทึก return_url ไม่สำเร็จ — ลูกค้าจะไม่ถูกพากลับหน้าร้านหลังชำระเงิน';
  }
  return out;
}

/*
 * POST /api/v2/payout/create (26 Oct 2026) — the v1 payout creation, called as is (same checks, same balance charge,
 * fee, commission and audit), then marked api_version = 'v2'. Only the meaning of the status differs from v1:
 *   PENDING   accepted and charged, not transferred yet            (v1 says COMPLETED here)
 *   COMPLETED the team made the transfer (admin ดำเนินการ = yes)
 *   FAILED    rejected / cancelled — amount + fee returned to the balance
 * Callbacks at every step: payout.pending (created; again with reopened: true if the transfer is undone),
 * payout.completed, payout.failed. /api/v1/payout/* is not touched.
 */
const v2Status = (o) => (o.status === 'rejected' ? 'FAILED' : o.status === 'approved' && o.admin_done ? 'COMPLETED' : 'PENDING');

/** The v1 payout object with the v2 status; completedAt = when it really finished (transferred / failed), else null. */
async function asV2(list) {
  const refs = list.map((p) => p.id);
  if (!refs.length) return list;
  const { rows } = await query('SELECT ref, status, admin_done, admin_done_at, completed_at FROM outflows WHERE ref = ANY ($1)', [refs]);
  const by = new Map(rows.map((r) => [r.ref, r]));
  return list.map((p) => {
    const o = by.get(p.id);
    if (!o) return p;
    const status = v2Status(o);
    return { ...p, status, completedAt: status === 'COMPLETED' ? o.admin_done_at ?? o.completed_at : status === 'FAILED' ? o.completed_at : null };
  });
}

export async function createPayoutV2(m, b, idem) {
  const out = await createPayout(m, b, idem);   // exactly what POST /api/v1/payout/create does
  if (!out.idempotent) {
    await query(`UPDATE outflows SET api_version = 'v2' WHERE ref = $1`, [out.payout.id]);
    // Step 1 of the v2 lifecycle: tell the shop's webhook it is pending (after the payout is saved).
    deliverPayoutEvent(out.payout.id, 'payout.pending').catch((err) => logger.warn({ err, ref: out.payout.id }, 'payout.pending webhook failed'));
  }
  const [p] = await asV2([out.payout]);
  return { ...out, payout: p };
}

export async function payoutV2(m, q) {
  const out = await payout(m, q);
  const [p] = await asV2([out.payout]);
  return { ...out, payout: p };
}

export async function payoutsV2(m, q) {
  const out = await payouts(m, q);
  return { ...out, data: await asV2(out.data ?? []) };
}
