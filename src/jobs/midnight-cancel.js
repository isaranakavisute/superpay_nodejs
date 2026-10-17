import { query } from '../db/pool.js';
import { reject as rejectPayment } from '../payments/payment.service.js';
import { reject as rejectOutflow } from '../outflows/outflow.service.js';
import { sendAlert } from '../alerts/alert.service.js';

/**
 * Every day at midnight (Asia/Bangkok) everything created before midnight that is not finished is rejected with
 * MIDNIGHT_REASON (agreed 17 Oct 2026):
 *   - payments not in สำเร็จ: pending (รอลูกค้าชำระ / รอตรวจสอบ / ส่งสลิปซ้ำ) and expired — each sends payment.rejected;
 *   - payouts not in "admin ดำเนินการเรียบร้อยแล้ว": pending (รอดำเนินการ) and approved with admin ดำเนินการ = no
 *     (รอ admin ดำเนินการ) — the shop's balance is returned and API payouts get payout.failed.
 * Only what was created from daily_jobs.since on counts (the moment this rule started, 17 Oct 2026) — older
 * unfinished items are left as they are.
 * Each item is rejected through the normal admin action in its own transaction (one failure doesn't stop the rest).
 * daily_jobs.last_run_for is claimed first, so a day runs once; if the server was down at midnight it runs on start,
 * still only for what was created before that midnight.
 */
export const MIDNIGHT_REASON = 'ยกเลิกเนื่องจากยังไม่ได้ดำเนินการภายในเที่ยงคืน';
const JOB = 'midnight_cancel';
const TZ_OFFSET_MS = 7 * 3_600_000;   // Asia/Bangkok (no DST)
const DAY = 24 * 3_600_000;

/** The latest Bangkok midnight at or before `now` (ms): { at: Date, day: 'YYYY-MM-DD' (the day that starts then) }. */
export function lastMidnight(now = Date.now()) {
  const local = now + TZ_OFFSET_MS;
  const start = local - (((local % DAY) + DAY) % DAY);
  return { at: new Date(start - TZ_OFFSET_MS), day: new Date(start).toISOString().slice(0, 10) };
}

/** Runs the job for the latest midnight if that day was not done yet. Returns the result, or null when already done. */
export async function runMidnightCancel(logger, now = Date.now()) {
  const { at, day } = lastMidnight(now);
  const { rows: claim } = await query(
    `UPDATE daily_jobs SET last_run_for = $2::date, last_run_at = now() WHERE job = $1 AND last_run_for < $2::date RETURNING since`,
    [JOB, day],
  );
  if (!claim[0]) return null;
  // No start time = nothing older than this run's own day is touched.
  const since = claim[0].since ?? at;
  const result = { day, since: new Date(since).toISOString(), cutoff: at.toISOString(), payments: 0, payouts: 0, failed: [] };
  const { rows: pays } = await query(
    `SELECT ref FROM payments WHERE status IN ('pending', 'expired') AND created_at >= $2 AND created_at < $1 ORDER BY id`, [at, since]);
  for (const { ref } of pays) {
    try { await rejectPayment(ref, 'system', MIDNIGHT_REASON); result.payments += 1; }
    catch (err) { result.failed.push(ref); logger.warn({ err, ref }, 'midnight cancel: payment not rejected'); }
  }
  const { rows: outs } = await query(
    `SELECT ref FROM outflows WHERE (status = 'pending' OR (status = 'approved' AND NOT admin_done)) AND created_at >= $2 AND created_at < $1 ORDER BY id`,
    [at, since]);
  for (const { ref } of outs) {
    try { await rejectOutflow(ref, 'system', MIDNIGHT_REASON); result.payouts += 1; }
    catch (err) { result.failed.push(ref); logger.warn({ err, ref }, 'midnight cancel: payout not rejected'); }
  }
  await query('UPDATE daily_jobs SET last_result = $2 WHERE job = $1', [JOB, JSON.stringify(result)]);
  logger.info(result, 'midnight cancel done');
  if (result.payments || result.payouts || result.failed.length) {
    await sendAlert('midnight.cancel', `🌙 ยกเลิกอัตโนมัติตอนเที่ยงคืน (${day}): รายการชำระเงิน ${result.payments} · รายการเงินออก ${result.payouts}`
      + (result.failed.length ? ` · ยกเลิกไม่ได้ ${result.failed.length}: ${result.failed.slice(0, 20).join(', ')}` : '')).catch(() => {});
  }
  return result;
}

let timer = null;
let running = false;
/** Checks every minute (and once on start) whether tonight's run is due. */
export function startMidnightCancel(logger) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runMidnightCancel(logger); }
    catch (err) { logger.error({ err }, 'midnight cancel failed'); }
    finally { running = false; }
  };
  void tick();
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}
