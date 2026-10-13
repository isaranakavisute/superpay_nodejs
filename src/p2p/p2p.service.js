import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { moveWithdrawalSplits } from '../merchants/tree.js';

export const refParamSchema = z.object({ ref: z.string().regex(/^P2P\d{1,12}$/, 'invalid P2P ref') });

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'p2p', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lockOpen(client, ref) {
  const { rows } = await client.query('SELECT * FROM p2p_matches WHERE ref = $1 FOR UPDATE', [ref]);
  if (!rows[0]) throw new NotFoundError(`P2P pair ${ref} does not exist`);
  if (!['reserved', 'disputed'].includes(rows[0].status)) throw new ConflictError(`${ref} is already ${rows[0].status}`, { status: rows[0].status });
  return rows[0];
}

/**
 * Settle: the depositor really paid the withdrawer. Approves the deposit order
 * and the withdrawal together; the payout is recorded as an approved outflow
 * (source p2p, no house account) so both shops' balances stay right.
 */
export function settle(ref, actor) {
  return withTransaction(async (client) => {
    const x = await lockOpen(client, ref);
    const { rows: pay } = await client.query(`SELECT id, status FROM payments WHERE ref = $1 FOR UPDATE`, [x.payment_ref]);
    const { rows: wd } = await client.query(`SELECT * FROM withdrawal_requests WHERE ref = $1 FOR UPDATE`, [x.withdrawal_ref]);
    if (!pay[0] || !wd[0]) throw new ConflictError(`${ref} points at a missing order or withdrawal`);
    if (['rejected', 'refunded'].includes(pay[0].status)) throw new ConflictError(`Deposit ${x.payment_ref} is ${pay[0].status}`);
    if (wd[0].status === 'rejected') throw new ConflictError(`Withdrawal ${x.withdrawal_ref} was rejected`);

    await client.query(`UPDATE payments SET status = 'approved', reviewed_by = $2, completed_at = now() WHERE id = $1 AND status <> 'approved'`, [pay[0].id, actor]);
    let outflowId = wd[0].outflow_id;
    if (!outflowId) {
      await client.query('LOCK TABLE outflows IN SHARE ROW EXCLUSIVE MODE');
      const { rows } = await client.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 40100) AS n FROM outflows WHERE ref ~ '^OUT[0-9]+$'`);
      const { rows: out } = await client.query(
        `INSERT INTO outflows (ref, merchant_id, category, bank_account_id, receiver_name, receiver_bank_code, receiver_account, amount, status, source, description, completed_at, fee)
         VALUES ($1, $2, 'transfer', NULL, $3, $4, $5, $6, 'approved', 'p2p', $7, now(), $8) RETURNING id`,
        [`OUT${Number(rows[0].n) + 1}`, wd[0].merchant_id, wd[0].receiver_name, wd[0].receiver_bank_code, wd[0].receiver_account, wd[0].amount, `P2P ${ref} — ลูกค้า ${x.payment_ref} โอนตรงให้ผู้ถอน`, wd[0].fee ?? 0],
      );
      outflowId = out[0].id;
      await moveWithdrawalSplits(client, wd[0].id, outflowId);
    } else {
      await client.query(`UPDATE outflows SET status = 'approved', completed_at = now() WHERE id = $1 AND status = 'pending'`, [outflowId]);
    }
    await client.query(`UPDATE withdrawal_requests SET status = 'approved', approved_by = coalesce(approved_by, $2), outflow_id = $3, decided_at = coalesce(decided_at, now()) WHERE id = $1`, [wd[0].id, actor, outflowId]);
    await client.query(`UPDATE p2p_matches SET status = 'settled', settled_at = now() WHERE id = $1`, [x.id]);
    await audit(client, actor, 'p2p.settle', ref, `ปิดคู่ ${x.payment_ref} ↔ ${x.withdrawal_ref} ${fmt(x.amount)} บาท`);
  });
}

/** Release: nobody paid. The withdrawal goes back to the pool (still pending); the deposit is untouched. */
export function release(ref, actor) {
  return withTransaction(async (client) => {
    const x = await lockOpen(client, ref);
    await client.query(`UPDATE p2p_matches SET status = 'released', released_at = now() WHERE id = $1`, [x.id]);
    await audit(client, actor, 'p2p.release', ref, `ปล่อยคู่ — ${x.withdrawal_ref} กลับเข้าพูล`);
  });
}
