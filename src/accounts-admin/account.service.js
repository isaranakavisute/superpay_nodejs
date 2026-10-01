import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { normalizePromptPayId } from '../shared/promptpay.js';

/**
 * Bank accounts page (/api/console/accounts-admin). "Reset" starts the
 * account's counters and balance again from now (balance_at_reset = 0);
 * no payment or outflow is touched.
 */
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const bodySchema = z.object({
  bankCode: z.string().trim().toUpperCase().max(10),
  accountNo: z.string().trim().regex(/^\d{6,20}$/, 'เลขบัญชีต้องเป็นตัวเลข 6–20 หลัก'),
  accountName: z.string().trim().min(1).max(120),
  accountType: z.enum(['receive', 'send', 'both']),
  promptpayId: z.string().trim().max(20).optional().or(z.literal('')),
  merchantId: z.union([z.literal(''), z.null(), z.coerce.number().int().positive()]).optional(),
});
export const resetAllSchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500) });

const audit = (c, actor, action, ref, detail) =>
  c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'account', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lock(c, id) {
  const { rows } = await c.query('SELECT * FROM bank_accounts WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new NotFoundError(`Account ${id} does not exist`);
  return rows[0];
}

async function clean(c, b) {
  const { rows } = await c.query('SELECT 1 FROM banks WHERE code = $1', [b.bankCode]);
  if (!rows[0]) throw new BadRequestError(`ไม่รู้จักรหัสธนาคาร ${b.bankCode}`);
  const pp = b.promptpayId ? normalizePromptPayId(b.promptpayId) : null;
  if (b.promptpayId && !pp) throw new BadRequestError('PromptPay ID ต้องเป็นเบอร์มือถือ 10 หลัก / เลขประจำตัว 13 หลัก / e-wallet 15 หลัก');
  const merchantId = b.merchantId ? Number(b.merchantId) : null;
  if (merchantId) {
    const { rows: m } = await c.query('SELECT 1 FROM merchants WHERE id = $1', [merchantId]);
    if (!m[0]) throw new BadRequestError('ไม่พบร้านค้า');
  }
  return { ...b, promptpayId: pp, merchantId, label: `${b.bankCode} ···${b.accountNo.slice(-4)}` };
}

export function create(actor, body) {
  return withTransaction(async (c) => {
    const b = await clean(c, body);
    const { rows: dup } = await c.query('SELECT id FROM bank_accounts WHERE bank_code = $1 AND account_no = $2', [b.bankCode, b.accountNo]);
    if (dup[0]) throw new ConflictError(`บัญชีนี้มีอยู่แล้ว (#${dup[0].id})`);
    const { rows } = await c.query(
      `INSERT INTO bank_accounts (label, bank_code, account_type, status, account_name, account_no, promptpay_id, merchant_id, counters_reset_at, balance_at_reset)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, now(), 0) RETURNING id`,
      [b.label, b.bankCode, b.accountType, b.accountName, b.accountNo, b.promptpayId, b.merchantId],
    );
    await audit(c, actor, 'account.create', b.label, `เพิ่มบัญชี ${b.accountName}`);
    return { id: rows[0].id };
  });
}

export function update(id, actor, body) {
  return withTransaction(async (c) => {
    await lock(c, id);
    const b = await clean(c, body);
    await c.query(
      `UPDATE bank_accounts SET label = $2, bank_code = $3, account_type = $4, account_name = $5, account_no = $6, promptpay_id = $7, merchant_id = $8 WHERE id = $1`,
      [id, b.label, b.bankCode, b.accountType, b.accountName, b.accountNo, b.promptpayId, b.merchantId],
    );
    await audit(c, actor, 'account.update', b.label, 'แก้ไขบัญชี');
  });
}

export function toggle(id, actor) {
  return withTransaction(async (c) => {
    const a = await lock(c, id);
    const to = a.status === 'active' ? 'inactive' : 'active';
    await c.query('UPDATE bank_accounts SET status = $2 WHERE id = $1', [id, to]);
    await audit(c, actor, to === 'active' ? 'account.enable' : 'account.disable', a.label, to === 'active' ? 'เปิดใช้งานบัญชี' : 'ปิดใช้งานบัญชี');
    return { status: to };
  });
}

export function reset(ids, actor) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(`UPDATE bank_accounts SET counters_reset_at = now(), balance_at_reset = 0 WHERE id = ANY ($1) RETURNING label`, [ids]);
    if (!rows.length) throw new NotFoundError('ไม่พบบัญชี');
    await audit(c, actor, 'account.reset', rows.length === 1 ? rows[0].label : `${rows.length} บัญชี`, 'ตั้งยอดเป็น 0 และเริ่มนับรายการใหม่');
    return { count: rows.length };
  });
}

/** Only accounts that never carried money can be deleted; others are disabled instead. */
export function remove(id, actor) {
  return withTransaction(async (c) => {
    const a = await lock(c, id);
    const { rows } = await c.query(
      `SELECT (SELECT count(*) FROM payments WHERE bank_account_id = $1) + (SELECT count(*) FROM outflows WHERE bank_account_id = $1) AS n`,
      [id],
    );
    if (Number(rows[0].n) > 0) throw new ConflictError(`บัญชีนี้มีรายการแล้ว ${rows[0].n} รายการ — ลบไม่ได้ ให้ปิดใช้งานแทน`);
    await c.query('DELETE FROM bank_accounts WHERE id = $1', [id]);
    await audit(c, actor, 'account.delete', a.label, 'ลบบัญชี');
  });
}
