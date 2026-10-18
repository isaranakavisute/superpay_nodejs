import { query } from '../db/pool.js';
import { reject as rejectPayment } from '../payments/payment.service.js';
import { sameCustomerByOrder } from '../merchant-api/slip-transfers.js';
import { sendAlert } from '../alerts/alert.service.js';

/**
 * Every day at 23:00 (Asia/Bangkok) — rule agreed 17 Oct 2026 (TXN174231 / TXN174469):
 *   order#1 was PAID (auto-approved from its slip, or approved by an admin);
 *   order#2 — same shop, same customer, same amount, created AFTER order#1 was approved — has no new payment:
 *     no slip at all, or only a slip whose transfer happened before order#2 existed / is already used (order#1's money);
 *   → order#2 is rejected ("ซ้ำกับ <order#1> ที่ชำระแล้ว …"), with payment.rejected + its Telegram alert as usual.
 * Left for a person: order#2 with a slip for a NEW transfer refused for another reason (it may be a real payment#2),
 * and slips still being re-checked. Only orders created today (Bangkok) before 23:00 are looked at.
 */
export const DUPLICATE_REASON = (ref) => `ซ้ำกับ ${ref} ที่ชำระแล้ว — ไม่มีเงินโอนใหม่สำหรับออเดอร์นี้ภายใน 23:00`;
const JOB = 'duplicate_cancel';
const TZ_OFFSET_MS = 7 * 3_600_000;
const DAY = 24 * 3_600_000;

/** The latest 23:00 Bangkok at or before `now`: { at, dayStart, day: 'YYYY-MM-DD' }. */
export function last2300(now = Date.now()) {
  const local = now + TZ_OFFSET_MS;
  let start = local - (((local % DAY) + DAY) % DAY);          // this Bangkok day's 00:00 (local ms)
  if (local < start + 23 * 3_600_000) start -= DAY;            // before 23:00: the previous day's 23:00
  return { at: new Date(start + 23 * 3_600_000 - TZ_OFFSET_MS), dayStart: new Date(start - TZ_OFFSET_MS), day: new Date(start).toISOString().slice(0, 10) };
}

/**
 * order#2 has no payment of its own, given order#1 { created_at, completed_at, transRef } (pure):
 *   no slip; or a refused slip whose transfer already paid an order; or a slip of order#1's OWN transfer — the same
 *   bank ref, or (order#1 approved by hand without a slip) a transfer made between order#1's creation and approval.
 * A DIFFERENT transfer refused for another reason (e.g. paid into the shop's old account) may be a real payment#2: no.
 */
export function noOwnPayment(o2, slip, o1) {
  if (!slip) return true;
  if (slip.recheck_at) return false;                                   // still being re-checked
  const vr = slip.verify_result ?? {};
  if (vr.decision !== 'invalid') return false;                         // accepted / waiting for an admin
  if (o2.slip_reused_ref || /ถูกใช้|ใช้ซ้ำ/.test(String(vr.message ?? ''))) return true;   // its money already paid an order
  if (vr.transRef && o1.transRef) return vr.transRef === o1.transRef;   // order#1's own transfer?
  if (!vr.date || o1.transRef) return false;
  const at = new Date(vr.date).getTime();
  return at >= new Date(o1.created_at).getTime() - 10 * 60_000 && at <= new Date(o1.completed_at).getTime();
}

export async function runDuplicateCancel(logger, now = Date.now()) {
  const { at, dayStart, day } = last2300(now);
  const { rows: claim } = await query(`UPDATE daily_jobs SET last_run_for = $2::date, last_run_at = now() WHERE job = $1 AND last_run_for < $2::date RETURNING job`, [JOB, day]);
  if (!claim[0]) return null;
  const result = { day, at: at.toISOString(), rejected: [], failed: [] };
  const { rows: cands } = await query(
    `SELECT p.id, p.ref, p.merchant_id, p.amount, p.customer_name, p.metadata, p.created_at, p.slip_reused_ref,
            s.payment_id AS has_slip, s.verify_result, s.recheck_at
       FROM payments p LEFT JOIN payment_slips s ON s.payment_id = p.id
      WHERE p.status IN ('pending', 'expired') AND p.merchant_id IS NOT NULL AND p.created_at >= $1 AND p.created_at < $2 ORDER BY p.id`,
    [dayStart, at],
  );
  for (const o2 of cands) {
    const { rows: firsts } = await query(
      `SELECT p.ref, p.customer_name, p.metadata, p.created_at, p.completed_at, coalesce(s.trans_ref, s.verify_result->>'transRef') AS "transRef"
         FROM payments p LEFT JOIN payment_slips s ON s.payment_id = p.id
        WHERE p.merchant_id = $1 AND p.status = 'approved' AND p.amount = $2
          AND p.completed_at < $3 AND p.created_at > $3::timestamptz - interval '24 hours' ORDER BY p.completed_at DESC`,
      [o2.merchant_id, o2.amount, o2.created_at],
    );
    const o1 = firsts.find((f) => sameCustomerByOrder(f, o2) && noOwnPayment(o2, o2.has_slip ? o2 : null, f));
    if (!o1) continue;
    try { await rejectPayment(o2.ref, 'system', DUPLICATE_REASON(o1.ref)); result.rejected.push(`${o2.ref}←${o1.ref}`); }
    catch (err) { result.failed.push(o2.ref); logger.warn({ err, ref: o2.ref }, 'duplicate cancel: not rejected'); }
  }
  await query('UPDATE daily_jobs SET last_result = $2 WHERE job = $1', [JOB, JSON.stringify(result)]);
  logger.info(result, 'duplicate cancel done');
  if (result.rejected.length || result.failed.length) {
    await sendAlert('midnight.cancel', `🕚 ยกเลิกออเดอร์ซ้ำตอน 23:00 (${day}): ${result.rejected.length} รายการ${result.rejected.length ? ` — ${result.rejected.slice(0, 30).join(', ')}` : ''}`
      + (result.failed.length ? ` · ยกเลิกไม่ได้: ${result.failed.join(', ')}` : '')).catch(() => {});
  }
  return result;
}

let timer = null;
let running = false;
export function startDuplicateCancel(logger) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runDuplicateCancel(logger); } catch (err) { logger.error({ err }, 'duplicate cancel failed'); } finally { running = false; }
  };
  void tick();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}
