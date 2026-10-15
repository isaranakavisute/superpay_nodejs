import { hasCustomer, nameMatches, normalizeSlip } from './slip-match.js';

/**
 * Carry-over: a genuine transfer made for an earlier, unpaid order of the same customer may pay a newer order.
 * E.g. the customer transfers ฿200 for a ฿250 order (TXN…21), that order expires, the shop creates a ฿200 order
 * (TXN…22) and sends the same slip — older than the new order, so the "slip after order" rule refuses it.
 * It is accepted when ALL hold (the caller already checked: EasySlip-verified, amount and receiving account match
 * the new order, and the transfer was never used for any order):
 *   - the same shop had an unpaid order (expired, cancelled, or still open) on the same receiving account, created
 *     before the transfer (10 min clock tolerance) and at most WINDOW_HOURS before it. A still-open one must not hold
 *     another slip that is accepted / waiting for review (that stays with the admin); the caller cancels it once
 *     the new order is approved (the transfer could never pay it);
 *   - the slip's payer is that order's customer (name, or the payer account digits on the order);
 *   - the transfer itself is at most WINDOW_HOURS old.
 */
export const WINDOW_HOURS = 24;

const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** The slip's payer is the earlier order's customer: name match, or the order's payer account digits on the slip. */
function sameCustomer(slip, order) {
  if (hasCustomer(order.customer_name) && nameMatches(slip?.senderNames ?? [], order.customer_name) === true) return true;
  const want = digits(order.payer_account_masked);
  const shown = digits(slip?.senderAccount);
  return want.length >= 4 && shown.length >= 4 && (shown.includes(want) || want.includes(shown));
}

/** The earlier unpaid order this transfer belongs to, or null. */
export async function carryOverFrom(c, p, v) {
  if (!v.date || !p.merchant_id || !p.bank_account_id) return null;
  const at = new Date(v.date);
  if (Date.now() - at.getTime() > WINDOW_HOURS * 3_600_000) return null;
  const slip = normalizeSlip(v.provider, v.raw);
  const { rows } = await c.query(
    `SELECT id, ref, merchant_order_id, amount, status, customer_name, payer_account_masked, created_at, expires_at FROM payments
      WHERE merchant_id = $1 AND bank_account_id = $2 AND id <> $3
        AND (status IN ('expired', 'rejected')
             OR (status = 'pending' AND NOT EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = payments.id
                                                     AND coalesce(s.verify_result->>'decision', '') <> 'invalid')))
        AND created_at <= $4::timestamptz + interval '10 minutes'
        AND created_at >= $4::timestamptz - make_interval(hours => $5)
      ORDER BY created_at DESC LIMIT 20`,
    [p.merchant_id, p.bank_account_id, p.id, at, WINDOW_HOURS],
  );
  return rows.find((o) => sameCustomer(slip, o)) ?? null;
}

/**
 * When a slip is accepted on `p`, other still-open orders of the same shop that hold the SAME slip as rejected
 * (e.g. a ฿500 slip refused on a ฿250 order, then accepted on a new ฿500 order) are cancelled: that transfer can
 * never pay them, and leaving them open only confuses. Same slip = same image or same bank QR. Returns their refs.
 */
export async function cancelSlipSiblings(c, p, fp) {
  if (!p.merchant_id || (!fp?.sha256 && !fp?.qr)) return [];
  const { rows } = await c.query(
    `UPDATE payments x SET status = 'rejected', completed_at = now(), reviewed_by = 'system',
            review_note = 'ยกเลิกอัตโนมัติ — สลิปเดียวกันใช้ชำระ ' || $3 || ' แทน'
      WHERE x.merchant_id = $1 AND x.id <> $2 AND x.status = 'pending'
        AND EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = x.id AND coalesce(s.verify_result->>'decision', '') = 'invalid'
                     AND (s.image_sha256 = $4 OR ($5::text IS NOT NULL AND s.qr_payload = $5)))
      RETURNING x.ref, x.merchant_order_id, x.amount`,
    [p.merchant_id, p.id, p.ref, fp.sha256 ?? null, fp.qr ?? null],
  );
  return rows;
}
