import { z } from 'zod';
import { minBalanceFor } from '../config-admin/config.service.js';
import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { BALANCE_SQL } from '../shared/balance-sql.js';
import { moveWithdrawalSplits } from '../merchants/tree.js';
import logger from '../logger.js';
import { deliverWithdrawalEvent } from '../webhooks/webhook.service.js';
import { lockRefNumbers } from '../shared/ref-lock.js';

/** Withdrawal webhook to the shop once the change has committed. */
const notify = (client, ref, event) =>
  client.afterCommit?.(() => deliverWithdrawalEvent(ref, event).catch((err) => logger.warn({ err, ref, event }, 'withdrawal webhook failed')));

export const refParamSchema = z.object({ ref: z.string().regex(/^WDR\d{1,12}$/, 'invalid withdrawal ref') });
export const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(300) });

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'withdrawal', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lock(client, ref) {
  const { rows } = await client.query('SELECT * FROM withdrawal_requests WHERE ref = $1 FOR UPDATE', [ref]);
  if (!rows[0]) throw new NotFoundError(`Withdrawal ${ref} does not exist`);
  if (rows[0].status !== 'pending') throw new ConflictError(`${ref} was already ${rows[0].status}`, { status: rows[0].status });
  return rows[0];
}

/** A reserved P2P pair means a customer may be paying the payee right now: never pay twice. */
async function refuseIfReserved(client, ref) {
  const { rows } = await client.query(`SELECT ref FROM p2p_matches WHERE withdrawal_ref = $1 AND status = 'reserved'`, [ref]);
  if (rows[0]) throw new ConflictError(`${ref} is reserved by P2P pair ${rows[0].ref} — release the pair first`);
}

/** Paying this would leave the shop under its minimum balance (settings / shop override). */
async function refuseBelowMinimum(client, w) {
  if (w.merchant_id == null) return;
  const { rows } = await client.query(
    `SELECT m.min_balance,
            ${BALANCE_SQL} AS balance
       FROM merchants m WHERE m.id = $1`,
    [w.merchant_id],
  );
  if (!rows[0]) return;
  const min = await minBalanceFor(rows[0].min_balance);
  const after = Number(rows[0].balance) - Number(w.amount) - Number(w.fee ?? 0);
  if (min > 0 && after < min) {
    throw new ConflictError(`ถอนไม่ได้: ยอดคงเหลือหลังถอน ${fmt(after)} บาท ต่ำกว่าขั้นต่ำ ${fmt(min)} บาท`, { code: 'below_min_balance' });
  }
}

/** Approve → creates the pending payout outflow (an admin transfers and approves it on the outflows page). */
export function approve(ref, actor) {
  return withTransaction(async (client) => {
    const w = await lock(client, ref);
    await refuseIfReserved(client, ref);
    await lockRefNumbers(client, 'outflows');
    await refuseBelowMinimum(client, w);
    const { rows } = await client.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 40100) AS n FROM outflows WHERE ref ~ '^OUT[0-9]+$'`);
    const outRef = `OUT${Number(rows[0].n) + 1}`;
    const { rows: out } = await client.query(
      `INSERT INTO outflows (ref, merchant_id, category, bank_account_id, receiver_name, receiver_bank_code, receiver_account, amount, status, source, description, fee)
       VALUES ($1, $2, 'other', NULL, $3, $4, $5, $6, 'pending', 'withdrawal', $7, $8) RETURNING id`,
      [outRef, w.merchant_id, w.receiver_name, w.receiver_bank_code, w.receiver_account, w.amount, `Withdrawal ${ref} — ${w.note ?? 'ถอนตามคำขอร้านค้า'}`, w.fee ?? 0],
    );
    await client.query(`UPDATE withdrawal_requests SET status = 'approved', approved_by = $2, outflow_id = $3, decided_at = now() WHERE id = $1`, [w.id, actor, out[0].id]);
    await moveWithdrawalSplits(client, w.id, out[0].id);
    await audit(client, actor, 'withdrawal.approve', ref, `อนุมัติ ${fmt(w.amount)} บาท → ${outRef}`);
    notify(client, ref, 'withdrawal.approved');
    return { outflowRef: outRef };
  });
}

export function reject(ref, actor, reason) {
  return withTransaction(async (client) => {
    const w = await lock(client, ref);
    await refuseIfReserved(client, ref);
    await client.query(`UPDATE withdrawal_requests SET status = 'rejected', approved_by = $2, reject_reason = $3, decided_at = now() WHERE id = $1`, [w.id, actor, reason]);
    await audit(client, actor, 'withdrawal.reject', ref, reason);
    notify(client, ref, 'withdrawal.rejected');
  });
}
