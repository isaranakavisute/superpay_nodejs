import { sameCustomer, WINDOW_HOURS } from './slip-carry-over.js';
import { verifySlip } from './slip-verify.js';
import logger from '../logger.js';

/**
 * How much of each bank transfer has paid orders (slip_transfers / slip_transfer_uses, migration 052).
 *
 * Normally one transfer pays one order in full: the left-over is 0 and nothing changes for anyone. A left-over only
 * appears when an admin approves an order with a slip for MORE than the order (17 Oct 2026, นราวดี สีพล: ฿1,500
 * transferred, TXN173429 approved at ฿500 → ฿1,000 left). That left-over pays new orders automatically, one at a time,
 * while it lasts (฿200 → ฿800 left …), when ALL hold:
 *   - the bank verified the slip (transRef known) — never from reading the image alone;
 *   - the left-over covers the new order's amount (more than the left-over is refused);
 *   - same shop and same receiving account as the transfer;
 *   - the slip's payer is the new order's customer (the carry-over rule: name, or the payer's account digits);
 *   - before leftover_until (LEFTOVER_HOURS after the transfer).
 * Every approval (automatic, admin, bulk) records its use in the same transaction, the transfer row locked, and the
 * database refuses used > amount — so two uploads at once can't both spend it.
 */
export const LEFTOVER_HOURS = WINDOW_HOURS;

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const baht = (n) => `฿${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const leftOf = (t) => r2(Number(t.amount) - Number(t.used));

/** The transfer row for a bank transRef, locked for this transaction; null when it never paid an order. */
export async function lockTransfer(c, transRef) {
  if (!transRef) return null;
  const { rows } = await c.query('SELECT * FROM slip_transfers WHERE trans_ref = $1 FOR UPDATE', [transRef]);
  return rows[0] ?? null;
}

/** The orders a transfer already paid (oldest first). */
export async function paidBy(c, transferId) {
  const { rows } = await c.query(
    `SELECT p.ref, p.merchant_order_id AS "orderId", u.amount FROM slip_transfer_uses u JOIN payments p ON p.id = u.payment_id
      WHERE u.transfer_id = $1 ORDER BY u.created_at, u.id`,
    [transferId],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/**
 * Whether transfer `t` may pay `order` from its left-over. Pure.
 * null: the transfer never paid an order (the normal checks apply). Otherwise { ok, left, reason, hint }:
 * ok = use the left-over (after = what stays after this order); not ok = the transfer is already used (the slip is
 * refused), with a hint for the shop when only the amount is too high.
 */
export function leftoverFor(t, order, slip, now = Date.now()) {
  if (!t || Number(t.used) <= 0) return null;
  const left = leftOf(t);
  if (left <= 0.009) return { ok: false, left: 0, reason: 'USED_UP' };
  if (Number(t.merchant_id) !== Number(order.merchant_id) || Number(t.bank_account_id) !== Number(order.bank_account_id)) {
    return { ok: false, left, reason: 'OTHER_SHOP' };
  }
  if (!t.leftover_until || new Date(t.leftover_until).getTime() < now) {
    return { ok: false, left, reason: 'EXPIRED', hint: `ยอดคงเหลือ ${baht(left)} ของการโอนนี้หมดเวลาใช้แล้ว — ติดต่อผู้ดูแล` };
  }
  if (Number(order.amount) > left + 0.009) {
    return { ok: false, left, reason: 'AMOUNT', hint: `ยอดคงเหลือของการโอนนี้ ${baht(left)} — ไม่พอสำหรับออเดอร์ยอด ${baht(order.amount)} · สร้างออเดอร์ยอดไม่เกิน ${baht(left)} เพื่อใช้ยอดนี้` };
  }
  if (!sameCustomer(slip, order)) return { ok: false, left, reason: 'CUSTOMER' };
  return { ok: true, left, after: r2(left - Number(order.amount)) };
}

/** The response checks for an order paid from a left-over: amount, time and duplicate judged against what was left. */
export function leftoverChecks(checks, lo, v) {
  const paid = lo.paid.map((x) => `${x.ref} ${baht(x.amount)}`).join(', ');
  return checks.map((x) => {
    if (x.check === 'AMOUNT') {
      return { ...x, status: 'PASS', detail: `ยอดคงเหลือของการโอน ${baht(lo.left)} (โอน ${baht(v.amount)} ใช้ชำระ ${paid} แล้ว) พอสำหรับยอดออเดอร์ — หลังชำระเหลือ ${baht(lo.after)}` };
    }
    if (x.check === 'TRANSFER_TIME' && x.status === 'FAIL') return { ...x, status: 'PASS', detail: `${x.detail} — ใช้ยอดคงเหลือของการโอนเดิม (ลูกค้าคนเดียวกัน) จึงใช้ได้` };
    return x;
  });
}

/**
 * Records that payment `paymentId` (just approved) used its slip's transfer: creates the transfer row on first use,
 * takes min(order amount, left-over), and puts the transRef on the slip row so later uploads see it as used.
 * No-op when the slip was not verified by the bank (no transRef / amount). Returns { transfer, take, uses } or null.
 */
export async function recordUse(c, paymentId, actor) {
  const { rows } = await c.query(
    `SELECT p.id, p.amount, p.merchant_id, p.bank_account_id, s.trans_ref, s.verify_result AS vr
       FROM payments p JOIN payment_slips s ON s.payment_id = p.id WHERE p.id = $1`,
    [paymentId],
  );
  const x = rows[0];
  const transRef = x?.trans_ref ?? x?.vr?.transRef;
  if (!x || !transRef || x.vr?.verified !== true || x.vr?.amount == null) return null;
  await c.query(
    `INSERT INTO slip_transfers (trans_ref, amount, merchant_id, bank_account_id, transfer_at, leftover_until)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(hours => $6)) ON CONFLICT (trans_ref) DO NOTHING`,
    [transRef, r2(x.vr.amount), x.merchant_id, x.bank_account_id, x.vr.date ?? null, LEFTOVER_HOURS],
  );
  const t = await lockTransfer(c, transRef);
  const { rows: had } = await c.query('SELECT amount FROM slip_transfer_uses WHERE payment_id = $1 AND transfer_id = $2', [paymentId, t.id]);
  if (had[0]) return { transfer: t, take: Number(had[0].amount), uses: null };
  const before = leftOf(t);
  const take = r2(Math.max(0, Math.min(Number(x.amount), before)));
  const kind = Number(t.used) > 0 ? (take > 0 ? 'leftover' : 'over_used') : take < Number(t.amount) - 0.009 ? 'partial' : 'full';
  await c.query('INSERT INTO slip_transfer_uses (transfer_id, payment_id, amount, kind, actor) VALUES ($1, $2, $3, $4, $5)', [t.id, paymentId, take, kind, actor ?? null]);
  const { rows: upd } = await c.query('UPDATE slip_transfers SET used = used + $2 WHERE id = $1 RETURNING *', [t.id, take]);
  // The unique index allows one slip row per transRef: the first order keeps it, later (left-over) ones hold it in verify_result.
  await c.query(
    `UPDATE payment_slips SET trans_ref = $2 WHERE payment_id = $1 AND trans_ref IS NULL AND NOT EXISTS (SELECT 1 FROM payment_slips WHERE trans_ref = $2)`,
    [paymentId, transRef],
  );
  const { rows: n } = await c.query('SELECT count(*)::int AS n FROM slip_transfer_uses WHERE transfer_id = $1', [t.id]);
  return { transfer: upd[0], take, kind, uses: n[0].n };
}

/**
 * A split transfer (paid 2+ orders) is now used up: other open / expired orders of the shop that hold a REFUSED slip
 * of the same transfer are closed — it can never pay them (e.g. TXN173893, the ฿1,500 order the transfer was first
 * sent for). Matched by the bank's transRef, so a different photo of the same slip counts too. Returns [{ ref, was }].
 */
export async function closeUsedUp(c, use, paymentId) {
  if (!use?.transfer || use.uses < 2 || leftOf(use.transfer) > 0.009) return [];
  const paid = (await paidBy(c, use.transfer.id)).map((x) => x.ref).join(' + ');
  const { rows } = await c.query(
    `WITH due AS (
       SELECT x.id, x.status FROM payments x
        WHERE x.merchant_id = $1 AND x.id <> $2 AND x.status IN ('pending', 'expired')
          AND EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = x.id AND s.verify_result->>'transRef' = $3
                        AND coalesce(s.verify_result->>'decision', '') = 'invalid')
        FOR UPDATE OF x)
     UPDATE payments p SET status = 'rejected', completed_at = now(), reviewed_by = 'system',
            review_note = 'ปิดรายการ — เงินโอนนี้ใช้ครบแล้ว (ชำระ ' || $4 || ') · ไม่มีการเติมเงินจากออเดอร์นี้'
       FROM due WHERE p.id = due.id RETURNING p.ref, due.status AS was`,
    [use.transfer.merchant_id, paymentId, use.transfer.trans_ref, paid],
  );
  return rows;
}

/**
 * Before an admin approves: a slip the bank verified before transRefs were stored on refused slips (before 17 Oct 2026)
 * is asked again once, so its transfer can be recorded. Never blocks the approval.
 */
export async function fillTransRefs(q, refs) {
  const { rows } = await q(
    `SELECT s.payment_id, s.mime, s.data FROM payment_slips s JOIN payments p ON p.id = s.payment_id
      WHERE p.ref = ANY ($1::text[]) AND s.trans_ref IS NULL AND s.verify_result->>'verified' = 'true'
        AND coalesce(s.verify_result->>'transRef', '') = ''`,
    [refs],
  );
  for (const s of rows) {
    try {
      const v = await verifySlip(s.data, s.mime, { pendingRetries: false, purpose: 'transfer_backfill' });
      if (v.verified === true && v.transRef) {
        await q(`UPDATE payment_slips SET verify_result = verify_result || jsonb_build_object('transRef', $2::text) WHERE payment_id = $1`, [s.payment_id, v.transRef]);
      }
    } catch (err) {
      logger.warn({ err, paymentId: s.payment_id }, 'slip transRef re-check failed');
    }
  }
}

/** Admin: give a left-over more time (from now, or from its current deadline if later). Only while money is left. */
export async function extendLeftover(c, id, actor, hours) {
  const { rows } = await c.query('SELECT * FROM slip_transfers WHERE id = $1 FOR UPDATE', [id]);
  const t = rows[0];
  if (!t) return { ok: false, error: 'ไม่พบรายการเงินโอนนี้' };
  if (leftOf(t) <= 0.009) return { ok: false, error: 'ยอดคงเหลือของการโอนนี้ใช้ครบแล้ว' };
  const { rows: upd } = await c.query(
    `UPDATE slip_transfers SET leftover_until = greatest(coalesce(leftover_until, now()), now()) + make_interval(hours => $2) WHERE id = $1 RETURNING leftover_until`,
    [id, hours],
  );
  await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'transfer.extend_leftover', 'slip_transfer', $2, $3)`,
    [actor ?? 'console', t.trans_ref, `ขยายเวลาใช้ยอดคงเหลือ ${baht(leftOf(t))} อีก ${hours} ชั่วโมง`]);
  return { ok: true, leftoverUntil: upd[0].leftover_until };
}

/**
 * No slip needed: a new order is the same customer as the order a transfer first paid when the shop's customer name
 * is the same (spaces / case ignored), or the full sender account number (metadata.senderAccountNumber) is the same.
 * Stricter than the slip rule on purpose — here only the shop's own order data links the order to the money. Pure.
 */
export function sameCustomerByOrder(paid, order) {
  const name = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
  const acct = (o) => String(o?.metadata?.senderAccountNumber ?? '').replace(/\D/g, '');
  if (name(paid.customer_name).length >= 2 && name(paid.customer_name) !== '-' && name(paid.customer_name) === name(order.customer_name)) return true;
  return acct(paid).length >= 8 && acct(paid) === acct(order);
}

/**
 * The open left-over (this shop, still within its time) that covers `amount` and belongs to this customer, locked for
 * the transaction — the one that expires first; null when there is none. Used when an order is created (no slip) and
 * when a slip is SHORT of its order (the left-over pays the difference). The customer: by the order's own data
 * (sameCustomerByOrder), or — when a bank-verified slip is given — the slip's payer is the left-over's customer.
 */
export async function openLeftoverFor(c, merchantId, amount, customer, slip = null) {
  const { rows } = await c.query(
    `SELECT t.*, f.customer_name AS paid_customer_name, f.metadata AS paid_metadata, f.payer_account_masked AS paid_payer_account_masked
       FROM slip_transfers t
       JOIN LATERAL (SELECT p.customer_name, p.metadata, p.payer_account_masked FROM slip_transfer_uses u JOIN payments p ON p.id = u.payment_id
                      WHERE u.transfer_id = t.id ORDER BY u.id LIMIT 1) f ON true
      WHERE t.merchant_id = $1 AND t.used > 0 AND t.amount - t.used >= $2::numeric - 0.005 AND t.leftover_until > now()
      ORDER BY t.leftover_until, t.id LIMIT 50
      FOR UPDATE OF t`,
    [merchantId, amount],
  );
  return rows.find((t) => {
    const paid = { customer_name: t.paid_customer_name, metadata: t.paid_metadata, payer_account_masked: t.paid_payer_account_masked };
    return sameCustomerByOrder(paid, customer) || (slip != null && sameCustomer(slip, paid));
  }) ?? null;
}

/** Records that order `paymentId` (created without a slip) is paid from transfer `t`'s left-over. Same shape as recordUse. */
export async function useLeftover(c, t, paymentId, amount, actor) {
  const take = r2(amount);
  if (take > leftOf(t) + 0.009) throw new Error('left-over does not cover the order');
  await c.query('INSERT INTO slip_transfer_uses (transfer_id, payment_id, amount, kind, actor) VALUES ($1, $2, $3, $4, $5)', [t.id, paymentId, take, 'leftover', actor ?? null]);
  const { rows: upd } = await c.query('UPDATE slip_transfers SET used = used + $2 WHERE id = $1 RETURNING *', [t.id, take]);
  const { rows: n } = await c.query('SELECT count(*)::int AS n FROM slip_transfer_uses WHERE transfer_id = $1', [t.id]);
  return { transfer: upd[0], take, kind: 'leftover', uses: n[0].n };
}

/**
 * After an order's own slip is recorded: when that transfer was SHORT of the order, the customer's open left-over pays
 * the difference (฿300 slip + ฿200 left-over = ฿500) — automatic approvals and admins alike, so the money is never
 * counted twice. `cover`: the left-over the slip check already chose (locked); otherwise looked up by the order's data.
 * Returns { use, short, cover, paid } or null when there is no shortfall / no left-over covers it.
 */
export async function coverShortfall(c, order, use, actor, cover = null) {
  if (!use || use.kind !== 'full') return null;
  const short = r2(Number(order.amount) - use.take);
  if (short <= 0.009) return null;
  let t = cover;
  if (!t) {
    // The left-over the slip check chose when the slip went to review (verify_result.coverTransferId), still in time.
    const { rows } = await c.query(`SELECT (verify_result->>'coverTransferId')::int AS id FROM payment_slips WHERE payment_id = $1`, [order.id]);
    if (rows[0]?.id) t = (await c.query('SELECT * FROM slip_transfers WHERE id = $1 AND leftover_until > now() FOR UPDATE', [rows[0].id])).rows[0] ?? null;
  }
  t ??= await openLeftoverFor(c, order.merchant_id, short, order);
  if (!t || leftOf(t) + 0.009 < short) return null;
  const paid = await paidBy(c, t.id);
  const used = await useLeftover(c, t, order.id, short, actor);
  return { use: used, short, cover: t, paid };
}
