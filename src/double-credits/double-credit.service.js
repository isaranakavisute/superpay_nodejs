import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../errors.js';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const noteBodySchema = z.object({ note: z.string().trim().max(300).optional() });
export const bulkBodySchema = z.object({
  action: z.enum(['clawback', 'dismiss']),
  ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  note: z.string().trim().max(300).optional(),
});

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'double_credit', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lockOpen(client, id) {
  const { rows } = await client.query('SELECT * FROM double_credits WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new NotFoundError(`Double-credit case ${id} does not exist`);
  if (rows[0].status !== 'open') throw new ConflictError(`Case ${id} is already resolved`);
  return rows[0];
}

/**
 * ดึงเงินคืน: reject the order that was approved by hand without its own slip.
 * Its amount (and fee) leave the shop's balance because only approved payments count.
 */
async function clawbackOne(client, id, actor, note) {
  const d = await lockOpen(client, id);
  const { rows } = await client.query(`SELECT id, status FROM payments WHERE ref = $1 FOR UPDATE`, [d.credited_ref]);
  if (!rows[0]) throw new ConflictError(`Order ${d.credited_ref} no longer exists`);
  if (rows[0].status !== 'approved') throw new ConflictError(`Order ${d.credited_ref} is ${rows[0].status}, not approved`);
  await client.query(
    `UPDATE payments SET status = 'rejected', review_note = $2, completed_at = now(), reviewed_by = $3 WHERE id = $1`,
    [rows[0].id, `ดึงเงินคืน — เติมเงินซ้ำกับ ${d.slip_holder_ref}`, actor],
  );
  await client.query(
    `UPDATE double_credits SET status = 'resolved', resolution_kind = 'clawback', resolution = coalesce($2, 'ดึงเงินคืนจากยอดร้านแล้ว'),
            resolved_by = $3, resolved_at = now() WHERE id = $1`,
    [id, note || null, actor],
  );
  await audit(client, actor, 'double_credit.clawback', d.credited_ref, `ดึงเงินคืน ${fmt(d.amount)} บาท (ซ้ำกับ ${d.slip_holder_ref})`);
}

async function dismissOne(client, id, actor, note) {
  const d = await lockOpen(client, id);
  await client.query(
    `UPDATE double_credits SET status = 'resolved', resolution_kind = 'not_duplicate', resolution = coalesce($2, 'ตรวจแล้วเป็นคนละรายการ'),
            resolved_by = $3, resolved_at = now() WHERE id = $1`,
    [id, note || null, actor],
  );
  await audit(client, actor, 'double_credit.dismiss', d.credited_ref, `ไม่ใช่ซ้ำ (เทียบกับ ${d.slip_holder_ref})`);
}

export const clawback = (id, actor, note) => withTransaction((c) => clawbackOne(c, id, actor, note));
export const dismiss = (id, actor, note) => withTransaction((c) => dismissOne(c, id, actor, note));

/** All-or-nothing across the selection. */
export function bulk(actor, { action, ids, note }) {
  return withTransaction(async (client) => {
    const unique = [...new Set(ids)];
    for (const id of unique) await (action === 'clawback' ? clawbackOne : dismissOne)(client, id, actor, note);
    return { count: unique.length };
  });
}
