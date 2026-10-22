import { z } from 'zod';
import { query } from '../db/pool.js';
import logger from '../logger.js';
import { createPayment, createPaymentSchema } from './v1.service.js';

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
