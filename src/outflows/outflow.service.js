import { query, withTransaction } from '../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';

/** Operator actions on outflows: lock → check transition → update → audit. */

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function lock(client, ref) {
  const { rows } = await client.query('SELECT id, ref, status, amount, bank_account_id, receiver_name FROM outflows WHERE ref = $1 FOR UPDATE', [ref]);
  if (!rows[0]) throw new NotFoundError(`Outflow ${ref} does not exist`);
  return rows[0];
}

function requireStatus(o, allowed, verb) {
  if (!allowed.includes(o.status)) throw new ConflictError(`Cannot ${verb} ${o.ref}: status is ${o.status}`, { status: o.status, allowed });
}

/** A deducting account must be active and allowed to send. */
async function requireSendAccount(client, id) {
  const { rows } = await client.query(`SELECT id FROM bank_accounts WHERE id = $1 AND status = 'active' AND account_type IN ('send', 'both')`, [id]);
  if (!rows[0]) throw new BadRequestError('Deducting account must be an active send / both account');
}

async function requireBank(client, code) {
  const { rows } = await client.query('SELECT 1 FROM banks WHERE code = $1', [code]);
  if (!rows[0]) throw new BadRequestError(`Unknown bank ${code}`);
}

const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'outflow', $3, $4)`, [actor ?? 'console', action, ref, detail]);

/**
 * The admin paid the recipient (outside Option Pay) and approves: the shop's balance is charged amount + fee.
 * The account it was paid from is optional — when given it must be an active send / both account.
 */
async function approveOne(client, ref, actor, bankAccountId, note) {
  const o = await lock(client, ref);
  requireStatus(o, ['pending'], 'approve');
  const account = bankAccountId ?? o.bank_account_id ?? null;
  if (account) await requireSendAccount(client, account);
  await client.query(`UPDATE outflows SET status = 'approved', bank_account_id = $2, completed_at = now(), review_note = coalesce($3, review_note),
                         admin_done = true, admin_done_at = now(), admin_done_by = $4 WHERE id = $1`,
    [o.id, account, note || null, actor ?? 'console']);
  await audit(client, actor, 'outflow.approve', ref, `โอนให้ ${o.receiver_name} ${fmt(o.amount)} บาท${account ? '' : ' (โอนนอกระบบ ไม่ระบุบัญชีที่หัก)'}${note ? ` · ${note}` : ''}`);
}

async function rejectOne(client, ref, actor, reason) {
  const o = await lock(client, ref);
  requireStatus(o, ['pending'], 'reject');
  await client.query(`UPDATE outflows SET status = 'rejected', review_note = $2, completed_at = now(), admin_done = true, admin_done_at = now(), admin_done_by = $3 WHERE id = $1`, [o.id, reason, actor ?? 'console']);
  await audit(client, actor, 'outflow.reject', ref, reason);
}

export const approve = (ref, actor, { bankAccountId, note } = {}) => withTransaction((c) => approveOne(c, ref, actor, bankAccountId, note));

/** "admin ดำเนินการ" yes / no — whether the team has made the bank transfer (admin-only; the shop never sees it). */
export const setAdminDone = (ref, actor, done) => withTransaction(async (client) => {
  const o = await lock(client, ref);
  await client.query(`UPDATE outflows SET admin_done = $2, admin_done_at = CASE WHEN $2 THEN now() END, admin_done_by = CASE WHEN $2 THEN $3 END WHERE id = $1`,
    [o.id, done, actor ?? 'console']);
  await audit(client, actor, 'outflow.admin_done', ref, `admin ดำเนินการ: ${done ? 'yes' : 'no'} (${o.receiver_name} ${fmt(o.amount)} บาท)`);
});
export const reject = (ref, actor, reason) => withTransaction((c) => rejectOne(c, ref, actor, reason));

/** All-or-nothing across the selection. */
export function bulk(actor, { action, refs, reason, bankAccountId, note }) {
  return withTransaction(async (client) => {
    const unique = [...new Set(refs)];
    for (const ref of unique) {
      if (action === 'approve') await approveOne(client, ref, actor, bankAccountId, note);
      else await rejectOne(client, ref, actor, reason);
    }
    return { count: unique.length };
  });
}

export function update(ref, actor, { category, bankAccountId, receiverBankCode, description }) {
  return withTransaction(async (client) => {
    const o = await lock(client, ref);
    if (bankAccountId != null && o.status === 'pending') await requireSendAccount(client, bankAccountId);
    if (bankAccountId !== o.bank_account_id && o.status !== 'pending') throw new ConflictError('The deducting account can only change while pending');
    await requireBank(client, receiverBankCode);
    await client.query(
      `UPDATE outflows SET category = $2, bank_account_id = $3, receiver_bank_code = $4, description = coalesce($5, description) WHERE id = $1`,
      [o.id, category, bankAccountId, receiverBankCode, description ?? null],
    );
    await audit(client, actor, 'outflow.update', ref, `หมวด ${category}`);
  });
}

export function create(actor, input) {
  return withTransaction(async (client) => {
    if (input.bankAccountId != null) await requireSendAccount(client, input.bankAccountId);
    await requireBank(client, input.receiverBankCode);
    await client.query('LOCK TABLE outflows IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 40100) AS n FROM outflows WHERE ref ~ '^OUT[0-9]+$'`);
    const ref = `OUT${Number(rows[0].n) + 1}`;
    await client.query(
      `INSERT INTO outflows (ref, merchant_id, category, bank_account_id, receiver_name, receiver_bank_code, receiver_account, amount, status, source, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'manual', $9)`,
      [ref, input.merchantId, input.category, input.bankAccountId, input.receiverName, input.receiverBankCode, input.receiverAccount, input.amount, input.description || null],
    );
    await audit(client, actor, 'outflow.create', ref, `สร้างรายการเงินออก ${fmt(input.amount)} บาท`);
    return { ref };
  });
}

export function remove(ref, actor) {
  return withTransaction(async (client) => {
    const o = await lock(client, ref);
    // Paid money stays on record.
    requireStatus(o, ['pending', 'rejected'], 'delete');
    const { rows } = await client.query('SELECT 1 FROM withdrawal_requests WHERE outflow_id = $1', [o.id]);
    if (rows[0]) throw new ConflictError(`Cannot delete ${ref}: it pays a withdrawal request`);
    await client.query('DELETE FROM outflows WHERE id = $1', [o.id]);
    await audit(client, actor, 'outflow.delete', ref, `ลบรายการ ${fmt(o.amount)} บาท`);
  });
}

export function uploadSlip(ref, actor, { mime, data }) {
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 5 * 1024 * 1024) throw new BadRequestError('Slip image must be 5 MB or smaller');
  return withTransaction(async (client) => {
    const o = await lock(client, ref);
    await client.query(
      `INSERT INTO outflow_slips (outflow_id, mime, data, uploaded_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (outflow_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [o.id, mime, bytes, actor],
    );
    await audit(client, actor, 'outflow.slip', ref, 'แนบสลิปโอนออก');
  });
}

export async function getSlip(ref) {
  const { rows } = await query('SELECT s.mime, s.data FROM outflow_slips s JOIN outflows o ON o.id = s.outflow_id WHERE o.ref = $1', [ref]);
  if (!rows[0]) throw new NotFoundError(`No slip for ${ref}`);
  return rows[0];
}
