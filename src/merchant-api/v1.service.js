import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import { internal as configOf, minBalanceFor } from '../config-admin/config.service.js';
import { approveOne, emitPaymentEvent } from '../payments/payment.service.js';
import { hashPassword, verifyPassword } from '../shared/password.js';
import { normalizePromptPayId, promptPayPayload } from '../shared/promptpay.js';
import { open as unseal, seal } from '../shared/secret-box.js';
import { findReusedSlip, isSampleSlip, SAMPLE_SLIP_MESSAGE, slipFingerprint } from '../shared/slip-fingerprint.js';
import { MERCHANT_PERMISSIONS } from './permission-catalog.js';
import { matchSlip } from './slip-match.js';
import { ocrCheckSlip } from './slip-ocr.js';
import { verifySlip } from './slip-verify.js';

/**
 * Merchant REST API v1. Every function gets the authenticated merchant row
 * (from the X-API-Key) and only ever touches that merchant's data.
 */
export class ApiError extends AppError {
  constructor(status, code, message, details) {
    super(message, { status, code, details });
  }
}

const sha = (v) => createHash('sha256').update(v).digest('hex');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const actorOf = (m) => `api:${m.slug}`;
const audit = (c, m, action, entity, ref, detail, actor = actorOf(m)) =>
  c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, $3, $4, $5)`, [actor, action, entity, ref, detail]);

const STATUS = { pending: 'PENDING', approved: 'PAID', rejected: 'CANCELLED', refunded: 'REFUNDED', expired: 'EXPIRED' };
const W_STATUS = { pending: 'PENDING', approved: 'APPROVED', rejected: 'REJECTED' };
const O_STATUS = { pending: 'PENDING', approved: 'COMPLETED', rejected: 'FAILED' };

// ---------- schemas ----------
const money = z.coerce.number().positive().max(10_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'ทศนิยมได้ไม่เกิน 2 ตำแหน่ง');
const orderId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:\-#/]+$/, 'orderId: ตัวอักษร ตัวเลข และ . _ : - # / เท่านั้น');
const bankCode = z.string().trim().toUpperCase().max(10);
export const createPaymentSchema = z.object({
  amount: money,
  orderId,
  description: z.string().trim().max(200).optional(),
  metadata: z.object({
    senderAccountNumber: z.string().trim().regex(/^\d{8,20}$/, 'senderAccountNumber ต้องเป็นตัวเลข ≥ 8 หลัก').optional(),
    senderBankCode: bankCode.optional(),
    memberName: z.string().trim().max(120).optional(),
    memberNameEn: z.string().trim().max(120).optional(),
    customerId: z.string().trim().max(64).optional(),
  }).optional(),
  bankAccountId: z.coerce.number().int().positive().optional(),
});
export const slipCreateSchema = createPaymentSchema.extend({ image: z.string().max(11_000_000).optional(), mime: z.string().max(20).optional() });
export const slipVerifySchema = z.object({ orderId, image: z.string().min(10).max(11_000_000), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
export const slipAttachSchema = z.object({ image: z.string().min(10).max(11_000_000), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().trim().toUpperCase().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const receiver = {
  amount: money,
  bankCode,
  accountNumber: z.string().trim().regex(/^\d{6,20}$/, 'accountNumber ต้องเป็นตัวเลข 6–20 หลัก'),
  accountName: z.string().trim().min(1).max(120),
  merchantRef: z.string().trim().min(1).max(64).optional(),
};
export const payoutSchema = z.object({ ...receiver, description: z.string().trim().max(200).optional() });
export const bulkPayoutSchema = z.object({ payouts: z.array(payoutSchema).min(1).max(100) });
export const withdrawalSchema = z.object({ ...receiver, note: z.string().trim().max(200).optional() });
export const accountSchema = z.object({
  type: z.enum(['BANK', 'PROMPTPAY']).default('BANK'),
  bankCode: bankCode.optional(),
  accountNumber: z.string().trim().regex(/^\d{6,20}$/).optional(),
  accountName: z.string().trim().max(120).optional(),
  promptPayId: z.string().trim().max(20).optional(),
});
export const webhookSchema = z.object({
  url: z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'webhook URL ต้องเป็น https://'),
  events: z.array(z.enum(['payment.approved', 'payment.rejected', 'withdrawal.approved'])).min(1).max(3).default(['payment.approved', 'payment.rejected']),
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(200).optional(),
  username: z.string().trim().toLowerCase().max(60).optional(),
  password: z.string().min(1).max(200),
}).refine((b) => b.email || b.username, 'ต้องส่ง email หรือ username');

/** POST /auth/login: the shop user's secret key (Merchant Portal → ตั้งค่า), never a password. */
export const apiLoginSchema = z.object({
  secretKey: z.string({ error: 'ต้องส่ง secretKey' }).trim().min(20, 'secretKey ไม่ถูกต้อง').max(200),
});

// ---------- helpers ----------

/** Pending orders past their expiry become expired (lazy, on every read/write). */
const expireDue = (c = { query }) => c.query(`UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()`);

async function balances(c, m) {
  const { rows } = await c.query(
    `SELECT m.min_balance,
            m.opening_balance
            + coalesce((SELECT sum(amount - fee) FROM payments WHERE merchant_id = m.id AND status = 'approved'), 0)
            - coalesce((SELECT sum(amount) FROM outflows WHERE merchant_id = m.id AND status = 'approved'), 0)
            + coalesce((SELECT sum(amount) FROM merchant_credit_adjustments WHERE merchant_id = m.id), 0) AS balance,
            coalesce((SELECT sum(amount) FROM outflows WHERE merchant_id = m.id AND status = 'pending'), 0)
            + coalesce((SELECT sum(amount) FROM withdrawal_requests WHERE merchant_id = m.id AND status = 'pending'), 0) AS reserved
       FROM merchants m WHERE m.id = $1`,
    [m.id],
  );
  const r = rows[0];
  const min = await minBalanceFor(r.min_balance);
  return { balance: round2(r.balance), reserved: round2(r.reserved), available: round2(Number(r.balance) - Number(r.reserved)), minBalance: min };
}

/** Money leaving the shop: per-transaction minimum, then balance and minimum balance. */
async function checkCanPay(c, m, amount) {
  const limits = await configOf('limits');
  if (Number(limits.minWithdraw) > 0 && amount < Number(limits.minWithdraw)) {
    throw new ApiError(400, 'below_min_amount', `ยอดต่ำกว่ายอดถอนขั้นต่ำ ${fmt(limits.minWithdraw)} บาท`, { minAmount: Number(limits.minWithdraw) });
  }
  await c.query('SELECT 1 FROM merchants WHERE id = $1 FOR UPDATE', [m.id]); // serialise a shop's payouts
  const b = await balances(c, m);
  if (amount > b.available) throw new ApiError(400, 'INSUFFICIENT_BALANCE', `ยอดที่ใช้ได้ไม่พอ (ใช้ได้ ${fmt(b.available)} บาท)`, { available: b.available });
  if (b.minBalance > 0 && b.available - amount < b.minBalance) {
    throw new ApiError(400, 'below_min_balance', `ถอนแล้วจะเหลือต่ำกว่ายอดคงเหลือขั้นต่ำ ${fmt(b.minBalance)} บาท`, { minBalance: b.minBalance, available: b.available });
  }
}

async function requireBank(c, code) {
  const { rows } = await c.query('SELECT code, name FROM banks WHERE code = $1', [code]);
  if (!rows[0]) throw new ApiError(400, 'INVALID_BANK_CODE', `ไม่รู้จักรหัสธนาคาร ${code}`);
  return rows[0];
}

const ACCOUNT_COLS = `a.id, a.bank_code, b.name AS bank_name, a.account_name, a.account_no, a.promptpay_id, a.merchant_id`;

/** Receiving account for a new order: the shop's own accounts first, else the central pool per Settings. */
async function pickAccount(c, m, requested) {
  const slip = await configOf('slip');
  const { rows: own } = await c.query(
    `SELECT ${ACCOUNT_COLS} FROM bank_accounts a JOIN banks b ON b.code = a.bank_code
      WHERE a.merchant_id = $1 AND a.status = 'active' AND a.account_type <> 'send' ORDER BY a.id`,
    [m.id],
  );
  const { rows: central } = slip.centralReceiving
    ? await c.query(`SELECT ${ACCOUNT_COLS} FROM bank_accounts a JOIN banks b ON b.code = a.bank_code
                      WHERE a.merchant_id IS NULL AND a.status = 'active' AND a.account_type <> 'send' ORDER BY a.id`)
    : { rows: [] };
  if (requested) {
    const hit = [...own, ...central].find((a) => a.id === requested);
    if (!hit) throw new ApiError(400, 'INVALID_BANK_ACCOUNT', `บัญชี ${requested} ใช้รับเงินให้ร้านนี้ไม่ได้`);
    return hit;
  }
  const pool = own.length ? own : central;
  if (!pool.length) throw new ApiError(400, 'NO_PAYMENT_ACCOUNT', 'ร้านนี้ยังไม่มีบัญชีรับเงินที่ใช้งานได้');
  if (pool.length === 1) return pool[0];
  if (!own.length && slip.centralDistribution === 'fixed' && slip.centralFixedAccountId) {
    const fixed = pool.find((a) => a.id === Number(slip.centralFixedAccountId));
    if (fixed) return fixed;
  }
  if (!own.length && slip.centralDistribution === 'random') return pool[Math.floor(Math.random() * pool.length)];
  // auto = least received today, count = fewest orders today (Bangkok day).
  const metric = !own.length && slip.centralDistribution === 'count' ? 'count(*)' : "coalesce(sum(amount) FILTER (WHERE status = 'approved'), 0)";
  const { rows } = await c.query(
    `SELECT bank_account_id AS id, ${metric} AS v FROM payments
      WHERE bank_account_id = ANY ($1) AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'
      GROUP BY bank_account_id`,
    [pool.map((a) => a.id)],
  );
  const used = Object.fromEntries(rows.map((r) => [r.id, Number(r.v)]));
  return [...pool].sort((a, b) => (used[a.id] ?? 0) - (used[b.id] ?? 0) || a.id - b.id)[0];
}

/** "Unique amount": add the smallest free satang so two equal pending orders on one account never collide. */
async function uniqueAmount(c, accountId, amount, maxSatang) {
  await c.query('SELECT 1 FROM bank_accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const { rows } = await c.query(
    `SELECT amount FROM payments WHERE bank_account_id = $1 AND status = 'pending' AND amount >= $2 AND amount <= $3`,
    [accountId, amount, round2(amount + maxSatang / 100)],
  );
  const taken = new Set(rows.map((r) => Math.round(Number(r.amount) * 100)));
  for (let s = 0; s <= maxSatang; s++) {
    const cents = Math.round(amount * 100) + s;
    if (!taken.has(cents)) return cents / 100;
  }
  throw new ApiError(400, 'DUPLICATE_PENDING_AMOUNT', 'มีออเดอร์ยอดนี้รอชำระเต็มทุกช่องสตางค์แล้ว — ลองใหม่อีกครั้ง');
}

function present(p, base) {
  const status = p.status === 'pending' && p.expires_at && new Date(p.expires_at) < new Date() ? 'EXPIRED' : STATUS[p.status];
  const qr = p.promptpay_id ? `${base}/api/v1/payment/qr/${p.checkout_token}.png` : null;
  return {
    id: p.checkout_token,
    ref: p.ref,
    merchantId: String(p.merchant_id),
    orderId: p.merchant_order_id,
    amount: Number(p.amount),
    fee: Number(p.fee),
    netAmount: round2(p.amount - p.fee),
    status,
    source: (p.source ?? 'api').toUpperCase(),
    paymentMethod: p.promptpay_id ? 'PROMPTPAY' : 'BANK_TRANSFER',
    description: p.description ?? null,
    qrCode: qr,
    qrCodeUrl: qr,
    qrExpiry: p.expires_at,
    checkoutUrl: `${base}/c?t=${p.checkout_token}`,
    createdAt: p.created_at,
    paidAt: p.status === 'approved' ? p.completed_at : null,
    copy: { amount: Number(p.amount).toFixed(2) },
  };
}
const presentAccount = (a) => ({
  id: String(a.id),
  type: a.promptpay_id ? 'PROMPTPAY' : 'BANK',
  accountNumber: a.promptpay_id ?? a.account_no,
  accountName: a.account_name ?? null,
  bankCode: a.bank_code ?? null,
  bankName: a.bank_name ?? null,
});

const PAY_SELECT = `SELECT p.*, a.promptpay_id, a.bank_code AS acct_bank, b.name AS acct_bank_name, a.account_name, a.account_no
  FROM payments p JOIN bank_accounts a ON a.id = p.bank_account_id JOIN banks b ON b.code = a.bank_code`;

async function payByToken(c, m, idOrRef) {
  const { rows } = await c.query(`${PAY_SELECT} WHERE p.merchant_id = $1 AND (p.checkout_token = $2 OR p.ref = $2)`, [m.id, idOrRef]);
  if (!rows[0]) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  return rows[0];
}

// ---------- payments ----------

export async function createPayment(m, b, { base, source = 'api', unique = true, actor } = {}) {
  const [limits, slip] = await Promise.all([configOf('limits'), configOf('slip')]);
  if (Number(limits.minDeposit) > 0 && b.amount < Number(limits.minDeposit)) {
    throw new ApiError(400, 'PAYMENT_CONTRACT_POLICY_VIOLATION', `ยอดต่ำกว่ายอดฝากขั้นต่ำ ${fmt(limits.minDeposit)} บาท`, { error: 'below_min_amount', minAmount: Number(limits.minDeposit) });
  }
  return withTransaction(async (c) => {
    await expireDue(c);
    const { rows: dup } = await c.query('SELECT ref FROM payments WHERE merchant_id = $1 AND merchant_order_id = $2', [m.id, b.orderId]);
    if (dup[0]) throw new ApiError(409, 'DUPLICATE_ORDER_ID', `orderId ${b.orderId} ถูกใช้แล้ว`, { ref: dup[0].ref });
    const acct = await pickAccount(c, m, b.bankAccountId);
    const amount = unique && slip.uniqueAmount ? await uniqueAmount(c, acct.id, b.amount, slip.uniqueAmountMaxSatang) : b.amount;
    const fee = round2((amount * Number(m.fee_percent)) / 100 + Number(m.fee_flat));
    const md = b.metadata ?? {};
    const { rows: bank } = md.senderBankCode ? await c.query('SELECT code FROM banks WHERE code = $1', [md.senderBankCode]) : { rows: [] };
    await c.query('LOCK TABLE payments IN SHARE ROW EXCLUSIVE MODE');
    const { rows: last } = await c.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 172800) AS n FROM payments WHERE ref ~ '^TXN[0-9]+$'`);
    const ref = `TXN${Number(last[0].n) + 1}`;
    const token = randomBytes(16).toString('hex');
    const { rows } = await c.query(
      `INSERT INTO payments (ref, merchant_id, merchant_order_id, customer_name, payer_bank_code, payer_account_masked, bank_account_id, amount, fee, commission,
                             status, source, checkout_token, description, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13,
               CASE WHEN $14::int > 0 THEN now() + make_interval(mins => $14::int) END, $15)
       RETURNING *`,
      [ref, m.id, b.orderId, md.memberName || '-', bank[0]?.code ?? null, md.senderAccountNumber ? `···${md.senderAccountNumber.slice(-4)}` : null, acct.id, amount, fee,
        round2(fee * 0.05), source, token, b.description ?? null, slip.orderTtlMinutes, b.metadata ? JSON.stringify(b.metadata) : null],
    );
    await audit(c, m, 'payment.create', 'payment', ref, `สร้างออเดอร์ผ่าน ${source === 'portal' ? 'Merchant Portal' : 'API'} ยอด ${fmt(amount)} บาท (${b.orderId})`, actor);
    return { success: true, transaction: present({ ...rows[0], promptpay_id: acct.promptpay_id }, base), selectedAccount: presentAccount(acct) };
  });
}

/** Store a slip, verify it with the configured provider, approve when it checks out. */
/** A slip that was accepted or is waiting for review (a rejected one may be replaced). */
async function hasAcceptedSlip(c, paymentId) {
  const { rows } = await c.query(
    `SELECT 1 FROM payment_slips WHERE payment_id = $1
        AND coalesce(verify_result->>'decision', '') <> 'invalid' AND coalesce(verify_result->>'verified', '') <> 'false'`,
    [paymentId],
  );
  return rows.length > 0;
}
async function lastSlipProblems(paymentId) {
  const { rows } = await query(
    `SELECT verify_result FROM payment_slips WHERE payment_id = $1 AND verify_result->>'decision' = 'invalid'`,
    [paymentId],
  );
  const r = rows[0]?.verify_result;
  if (!r) return null;
  return Array.isArray(r.mismatches) && r.mismatches.length ? r.mismatches : [r.message ?? 'สลิปไม่ผ่านการตรวจ'];
}
const slipTaken = () => new ApiError(409, 'SLIP_ALREADY_UPLOADED', 'ได้รับสลิปของรายการนี้แล้ว — ส่งซ้ำไม่ได้ หากมีปัญหาโปรดติดต่อร้านค้า');

/** `once`: refuse when an accepted / in-review slip is already attached (customer checkout page). */
async function attachAndVerify(m, p, { image, mime }, base, { once = false } = {}) {
  const buf = Buffer.from(image, 'base64');
  if (buf.length < 100 || buf.length > 8 << 20) throw new ApiError(400, 'INVALID_SLIP', 'ไฟล์สลิปต้องเป็นรูปขนาดไม่เกิน 8 MB');
  if (!['pending', 'expired'].includes(p.status)) throw new ApiError(409, 'ORDER_NOT_PENDING', `ออเดอร์นี้สถานะ ${STATUS[p.status]} แล้ว`);
  if (once && (await hasAcceptedSlip({ query }, p.id))) throw slipTaken();
  const fp = slipFingerprint(buf, mime);
  if (isSampleSlip(fp)) throw new ApiError(400, 'SAMPLE_SLIP', SAMPLE_SLIP_MESSAGE);
  const v = await verifySlip(buf, mime);
  // No definite answer from a provider (none connected / down): read the slip image itself.
  const ocr = v.verified === null ? await ocrCheckSlip(buf, p, v.cfg) : null;
  const via = ocr ? 'ocr' : v.provider;
  return withTransaction(async (c) => {
    await c.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE', [p.id]);
    if (once && (await hasAcceptedSlip(c, p.id))) throw slipTaken();
    // One transfer pays one order: the same slip (file or bank QR) already on another order is refused.
    let reusedOn = await findReusedSlip(c, p.id, fp);
    let decision = 'review';
    let reason = v.message ?? null;
    let mismatches = [];
    if (v.verified === false) { decision = 'invalid'; mismatches = [reason]; }
    else if (v.verified) {
      const ageOk = !v.cfg.slipAgeCheck || !v.date || (v.cfg.slipMaxAgeHours === 0
        ? new Date(v.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) === new Date(p.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
        : Date.now() - new Date(v.date).getTime() <= v.cfg.slipMaxAgeHours * 3_600_000);
      // Amount, receiver account/bank, sender name and transfer time must all fit this order.
      const { problems, unknown } = matchSlip(v, p);
      if (!ageOk) problems.push(v.cfg.slipMaxAgeHours === 0 ? 'สลิปต้องเป็นการโอนวันเดียวกับที่สร้างรายการ' : `สลิปเก่าเกิน ${v.cfg.slipMaxAgeHours} ชั่วโมง — ใช้สลิปเก่าไม่ได้`);
      if (problems.length) { decision = 'invalid'; mismatches = problems; reason = problems.join(' · '); }
      else {
        if (v.transRef) {
          const { rows } = await c.query('SELECT p.ref FROM payment_slips s JOIN payments p ON p.id = s.payment_id WHERE s.trans_ref = $1 AND s.payment_id <> $2', [v.transRef, p.id]);
          if (rows[0]) reusedOn ??= rows[0].ref;
        }
        if (unknown.length) { decision = 'review'; reason = `${unknown.join(' · ')} — รอผู้ดูแลตรวจ`; }
        else if (v.cfg.requireApproval) { decision = 'review'; reason = 'สลิปถูกต้อง — รอผู้ดูแลยืนยัน (ตั้งค่า "ต้องให้ผู้ดูแลยืนยันก่อน")'; }
        else decision = 'approve';
      }
    } else if (ocr) {
      // Pixels can be edited: numbers that clearly differ reject; a match still needs the admin.
      if (ocr.problems.length) { decision = 'invalid'; mismatches = ocr.problems; reason = ocr.problems.join(' · '); }
      else reason = [ocr.matched.length ? `ตรงกับรายการ: ${ocr.matched.join(', ')}` : null, ...ocr.flags].filter(Boolean).join(' · ') + ' — อ่านจากภาพสลิป รอผู้ดูแลยืนยัน';
    }
    // The other order's ref is kept for the admin (it may belong to another shop), not shown to the uploader.
    if (reusedOn) { decision = 'invalid'; reason = 'สลิปนี้ถูกใช้กับรายการอื่นแล้ว — ใช้ซ้ำไม่ได้'; mismatches = [reason]; }
    await c.query(
      `INSERT INTO payment_slips (payment_id, mime, data, uploaded_by, provider, trans_ref, verify_result, image_sha256, qr_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (payment_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now(),
         provider = EXCLUDED.provider, trans_ref = EXCLUDED.trans_ref, verify_result = EXCLUDED.verify_result,
         image_sha256 = EXCLUDED.image_sha256, qr_payload = EXCLUDED.qr_payload`,
      [p.id, mime, buf, actorOf(m), via, decision === 'approve' || decision === 'review' ? v.transRef ?? null : null,
        JSON.stringify({ verified: v.verified, amount: v.amount ?? null, date: v.date ?? null, message: reason, decision, mismatches, ocr }), fp.sha256, fp.qr],
    );
    await c.query('UPDATE payments SET slip_received_at = now(), review_note = coalesce($2, review_note), slip_reused_ref = $3 WHERE id = $1', [p.id, reason, reusedOn]);
    if (decision === 'approve') await approveOne(c, p.ref, 'system', `ตรวจสลิปผ่าน ${v.provider}`);
    await audit(c, m, 'payment.slip', 'payment', p.ref, `แนบสลิป · ${via}: ${decision === 'approve' ? 'ผ่าน — อนุมัติอัตโนมัติ' : reason ?? decision}`);
    const { rows } = await c.query(`${PAY_SELECT} WHERE p.id = $1`, [p.id]);
    return {
      success: decision !== 'invalid',
      verified: decision === 'approve',
      result: decision === 'approve' ? 'PAID' : decision === 'invalid' ? 'INVALID_SLIP' : 'PENDING_REVIEW',
      message: decision === 'approve' ? 'ตรวจสลิปผ่าน — ออเดอร์ชำระแล้ว' : reason,
      mismatches,
      transaction: present(rows[0], base),
    };
  });
}

export async function createSlipPayment(m, b, { base }) {
  const created = await createPayment(m, b, { base, source: 'slip', unique: false });
  if (!b.image) return created;
  const p = await payByToken({ query }, m, created.transaction.id);
  return attachAndVerify(m, p, { image: b.image, mime: b.mime ?? 'image/jpeg' }, base);
}

export async function verifyByOrder(m, b, { base }) {
  await expireDue();
  const { rows } = await query(`${PAY_SELECT} WHERE p.merchant_id = $1 AND p.merchant_order_id = $2`, [m.id, b.orderId]);
  if (!rows[0]) throw new ApiError(404, 'ORDER_NOT_FOUND', `ไม่พบ orderId ${b.orderId}`);
  return attachAndVerify(m, rows[0], b, base);
}

export async function attachByRef(m, ref, b, { base }) {
  await expireDue();
  return attachAndVerify(m, await payByToken({ query }, m, ref), b, base);
}

export async function byOrder(m, id, { base }) {
  await expireDue();
  const { rows } = await query(`${PAY_SELECT} WHERE p.merchant_id = $1 AND p.merchant_order_id = $2`, [m.id, id]);
  if (!rows[0]) throw new ApiError(404, 'ORDER_NOT_FOUND', `ไม่พบ orderId ${id}`);
  return { success: true, transaction: present(rows[0], base) };
}

/** Public: what the customer checkout page needs (no key; the token is the secret). */
export async function checkout(token, { base }) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  await expireDue();
  const { rows } = await query(`${PAY_SELECT.replace('SELECT p.*', 'SELECT p.*, m.name AS merchant_name')} JOIN merchants m ON m.id = p.merchant_id WHERE p.checkout_token = $1`, [token]);
  const p = rows[0];
  if (!p) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  const t = present(p, base);
  return {
    success: true,
    transaction: { id: t.id, orderId: t.orderId, amount: t.amount, status: t.status, description: t.description, qrExpiry: t.qrExpiry, createdAt: t.createdAt, paidAt: t.paidAt, copy: t.copy, paymentMethod: t.paymentMethod },
    merchant: { name: p.merchant_name },
    account: { bankCode: p.acct_bank, bankName: p.acct_bank_name, accountName: p.account_name, accountNumber: p.account_no, promptPayId: p.promptpay_id },
    qrPayload: p.status === 'pending' && t.status === 'PENDING' ? promptPayPayload(p.promptpay_id, p.amount) : null,
    // What the slip must show (the payment page lists it).
    customerName: p.customer_name && p.customer_name !== '-' ? p.customer_name : null,
    hasSlip: !!p.slip_received_at,
    slipLocked: await hasAcceptedSlip({ query }, p.id),
    // Why the last slip was refused, so the page can say what to fix.
    slipProblems: p.slip_received_at ? await lastSlipProblems(p.id) : null,
  };
}

/** Public slip upload from the checkout page (the token authorises it). */
export async function checkoutSlip(token, b, { base }) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  await expireDue();
  const { rows } = await query(`${PAY_SELECT.replace('SELECT p.*', 'SELECT p.*, m.slug, m.id AS mid')} JOIN merchants m ON m.id = p.merchant_id WHERE p.checkout_token = $1`, [token]);
  if (!rows[0]) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  const r = await attachAndVerify({ id: rows[0].mid, slug: `${rows[0].slug}:checkout` }, rows[0], b, base, { once: true });
  return { success: r.success, verified: r.verified, result: r.result, message: r.message, mismatches: r.mismatches, status: r.transaction.status };
}

// ---------- transactions ----------

const statusFilter = (s, map) => {
  if (!s) return null;
  const want = s.split(',').map((x) => x.trim());
  const keys = Object.entries(map).filter(([, v]) => want.includes(v)).map(([k]) => k);
  return keys.length ? keys : ['__none__'];
};

export async function transactions(m, q, { base }) {
  await expireDue();
  const st = statusFilter(q.status, STATUS);
  const args = [m.id, st, q.from ?? null, q.to ?? null];
  const where = `p.merchant_id = $1 AND ($2::text[] IS NULL OR p.status = ANY ($2)) AND ($3::timestamptz IS NULL OR p.created_at >= $3) AND ($4::timestamptz IS NULL OR p.created_at < $4)`;
  const [{ rows }, { rows: n }] = await Promise.all([
    query(`${PAY_SELECT} WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`, args),
    query(`SELECT count(*)::int AS n FROM payments p WHERE ${where}`, args),
  ]);
  return { success: true, data: rows.map((p) => present(p, base)), pagination: { total: n[0].n, limit: q.limit, offset: q.offset } };
}

export async function transaction(m, id, { base }) {
  await expireDue();
  return { success: true, transaction: present(await payByToken({ query }, m, id), base) };
}

export function cancel(m, id, { base }) {
  return withTransaction(async (c) => {
    await expireDue(c);
    const p = await payByToken(c, m, id);
    if (!['pending', 'expired'].includes(p.status)) throw new ApiError(409, 'ORDER_NOT_PENDING', `ยกเลิกไม่ได้ — สถานะ ${STATUS[p.status]}`);
    await c.query(`UPDATE payments SET status = 'rejected', completed_at = now(), reviewed_by = $2, review_note = 'ยกเลิกโดยร้านค้า (API)' WHERE id = $1`, [p.id, actorOf(m)]);
    await audit(c, m, 'payment.cancel', 'payment', p.ref, 'ร้านค้ายกเลิกออเดอร์ผ่าน API');
    emitPaymentEvent(c, p.ref, 'payment.rejected');
    const { rows } = await c.query(`${PAY_SELECT} WHERE p.id = $1`, [p.id]);
    return { success: true, transaction: present(rows[0], base) };
  });
}

// ---------- payouts (outflows created by the shop) ----------

const presentPayout = (o) => ({
  id: o.ref, merchantRef: o.merchant_ref, amount: Number(o.amount), status: O_STATUS[o.status], bankCode: o.receiver_bank_code,
  accountNumber: o.receiver_account, accountName: o.receiver_name, description: o.description, createdAt: o.created_at, completedAt: o.completed_at,
  failureReason: o.status === 'rejected' ? o.review_note : null,
});

async function payoutOne(c, m, b, idem) {
  if (idem) {
    const { rows } = await c.query('SELECT * FROM outflows WHERE merchant_id = $1 AND idempotency_key = $2', [m.id, idem]);
    if (rows[0]) return { payout: presentPayout(rows[0]), idempotent: true };
  }
  if (b.merchantRef) {
    const { rows } = await c.query('SELECT ref FROM outflows WHERE merchant_id = $1 AND merchant_ref = $2', [m.id, b.merchantRef]);
    if (rows[0]) throw new ApiError(409, 'DUPLICATE_MERCHANT_REF', `merchantRef ${b.merchantRef} ถูกใช้แล้ว (${rows[0].ref})`);
  }
  await requireBank(c, b.bankCode);
  await checkCanPay(c, m, b.amount);
  await c.query('LOCK TABLE outflows IN SHARE ROW EXCLUSIVE MODE');
  const { rows: last } = await c.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 40100) AS n FROM outflows WHERE ref ~ '^OUT[0-9]+$'`);
  const ref = `OUT${Number(last[0].n) + 1}`;
  const { rows } = await c.query(
    `INSERT INTO outflows (ref, merchant_id, category, receiver_name, receiver_bank_code, receiver_account, amount, status, source, description, merchant_ref, idempotency_key)
     VALUES ($1, $2, 'transfer', $3, $4, $5, $6, 'pending', 'api', $7, $8, $9) RETURNING *`,
    [ref, m.id, b.accountName, b.bankCode, b.accountNumber, b.amount, b.description ?? `Payout ผ่าน API${b.merchantRef ? ` (${b.merchantRef})` : ''}`, b.merchantRef ?? null, idem ?? null],
  );
  await audit(c, m, 'outflow.create', 'outflow', ref, `Payout ผ่าน API ${fmt(b.amount)} บาท → ${b.bankCode} ···${b.accountNumber.slice(-4)}`);
  return { payout: presentPayout(rows[0]) };
}

export const createPayout = (m, b, idem) => withTransaction(async (c) => ({ success: true, ...(await payoutOne(c, m, b, idem)) }));

export async function bulkPayout(m, { payouts }) {
  const results = [];
  for (const [i, b] of payouts.entries()) {
    try {
      results.push({ index: i, success: true, ...(await withTransaction((c) => payoutOne(c, m, b))) });
    } catch (err) {
      results.push({ index: i, success: false, error: { code: err.code ?? 'internal_error', message: err.expected ? err.message : 'Internal error' } });
    }
  }
  return { success: results.every((r) => r.success), created: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, results };
}

export async function payout(m, { id, merchantRef }) {
  const { rows } = await query(`SELECT * FROM outflows WHERE merchant_id = $1 AND ${id ? 'ref' : 'merchant_ref'} = $2`, [m.id, id ?? merchantRef]);
  if (!rows[0]) throw new ApiError(404, 'PAYOUT_NOT_FOUND', 'ไม่พบ payout');
  return { success: true, payout: presentPayout(rows[0]) };
}

export async function payouts(m, q) {
  const st = statusFilter(q.status, O_STATUS);
  const args = [m.id, st, q.from ?? null, q.to ?? null];
  const where = `merchant_id = $1 AND ($2::text[] IS NULL OR status = ANY ($2)) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4)`;
  const [{ rows }, { rows: n }] = await Promise.all([
    query(`SELECT * FROM outflows WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${q.limit} OFFSET ${q.offset}`, args),
    query(`SELECT count(*)::int AS n FROM outflows WHERE ${where}`, args),
  ]);
  return { success: true, data: rows.map(presentPayout), pagination: { total: n[0].n, limit: q.limit, offset: q.offset } };
}

// ---------- withdrawal requests ----------

const presentWdr = (w) => ({
  requestRef: w.ref, merchantRef: w.merchant_ref, amount: Number(w.amount), status: W_STATUS[w.status], bankCode: w.receiver_bank_code,
  accountNumber: w.receiver_account, accountName: w.receiver_name, note: w.note, rejectReason: w.reject_reason, createdAt: w.created_at, decidedAt: w.decided_at,
});

export function createWithdrawal(m, b) {
  return withTransaction(async (c) => {
    if (b.merchantRef) {
      const { rows } = await c.query('SELECT ref FROM withdrawal_requests WHERE merchant_id = $1 AND merchant_ref = $2', [m.id, b.merchantRef]);
      if (rows[0]) throw new ApiError(409, 'DUPLICATE_MERCHANT_REF', `merchantRef ${b.merchantRef} ถูกใช้แล้ว (${rows[0].ref})`);
    }
    await requireBank(c, b.bankCode);
    await checkCanPay(c, m, b.amount);
    await c.query('LOCK TABLE withdrawal_requests IN SHARE ROW EXCLUSIVE MODE');
    const { rows: last } = await c.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 90000) AS n FROM withdrawal_requests WHERE ref ~ '^WDR[0-9]+$'`);
    const ref = `WDR${Number(last[0].n) + 1}`;
    const { rows } = await c.query(
      `INSERT INTO withdrawal_requests (ref, merchant_id, receiver_name, receiver_bank_code, receiver_account, amount, note, status, merchant_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
      [ref, m.id, b.accountName, b.bankCode, b.accountNumber, b.amount, b.note ?? null, b.merchantRef ?? null],
    );
    await audit(c, m, 'withdrawal.create', 'withdrawal', ref, `คำขอถอนผ่าน API ${fmt(b.amount)} บาท`);
    return { success: true, request: presentWdr(rows[0]) };
  });
}

export async function withdrawals(m, q) {
  const st = statusFilter(q.status, W_STATUS);
  const args = [m.id, st, q.from ?? null, q.to ?? null];
  const where = `merchant_id = $1 AND ($2::text[] IS NULL OR status = ANY ($2)) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4)`;
  const [{ rows }, { rows: n }] = await Promise.all([
    query(`SELECT * FROM withdrawal_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${q.limit} OFFSET ${q.offset}`, args),
    query(`SELECT count(*)::int AS n FROM withdrawal_requests WHERE ${where}`, args),
  ]);
  return { success: true, data: rows.map(presentWdr), pagination: { total: n[0].n, limit: q.limit, offset: q.offset } };
}

export async function withdrawal(m, ref) {
  const { rows } = await query('SELECT * FROM withdrawal_requests WHERE merchant_id = $1 AND (ref = $2 OR merchant_ref = $2) ORDER BY (ref = $2) DESC LIMIT 1', [m.id, ref]);
  if (!rows[0]) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอถอน');
  return { success: true, request: presentWdr(rows[0]) };
}

// ---------- receiving accounts ----------

export async function accounts(m) {
  const slip = await configOf('slip');
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS}, a.status FROM bank_accounts a JOIN banks b ON b.code = a.bank_code WHERE a.merchant_id = $1 ORDER BY a.id`,
    [m.id],
  );
  return {
    success: true,
    data: rows.map((a) => ({ ...presentAccount(a), status: a.status.toUpperCase() })),
    centralReceiving: slip.centralReceiving,
    note: rows.some((a) => a.status === 'active') ? null : slip.centralReceiving ? 'ยังไม่มีบัญชีของร้าน — ออเดอร์จะใช้บัญชีกลางของระบบ' : 'ยังไม่มีบัญชีรับเงิน — สร้างออเดอร์ไม่ได้จนกว่าจะเพิ่มบัญชี',
  };
}

export function addAccount(m, b) {
  return withTransaction(async (c) => {
    let pp = null;
    if (b.type === 'PROMPTPAY') {
      pp = normalizePromptPayId(b.promptPayId ?? b.accountNumber);
      if (!pp) throw new ApiError(400, 'INVALID_PROMPTPAY_ID', 'PromptPay ID ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขประจำตัว 13 หลัก');
    }
    if (b.type === 'BANK' && (!b.bankCode || !b.accountNumber)) throw new ApiError(400, 'PAYMENT_CONTRACT_POLICY_VIOLATION', 'ต้องส่ง bankCode และ accountNumber');
    const code = b.bankCode ?? 'KBANK';
    await requireBank(c, code);
    const digits = b.accountNumber ?? pp;
    const { rows } = await c.query(
      `INSERT INTO bank_accounts (label, bank_code, account_type, status, account_name, account_no, promptpay_id, merchant_id)
       VALUES ($1, $2, 'receive', 'active', $3, $4, $5, $6) RETURNING id`,
      [`${code} ···${digits.slice(-4)}`, code, b.accountName ?? m.name, b.accountNumber ?? null, pp, m.id],
    );
    await audit(c, m, 'account.create', 'account', String(rows[0].id), `ร้านเพิ่มบัญชีรับเงินผ่าน API (${b.type})`);
    const { rows: a } = await c.query(`SELECT ${ACCOUNT_COLS}, a.status FROM bank_accounts a JOIN banks b ON b.code = a.bank_code WHERE a.id = $1`, [rows[0].id]);
    return { success: true, account: { ...presentAccount(a[0]), status: 'ACTIVE' } };
  });
}

export function removeAccount(m, id) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(`UPDATE bank_accounts SET status = 'inactive' WHERE id = $1 AND merchant_id = $2 RETURNING id`, [id, m.id]);
    if (!rows[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'ไม่พบบัญชีของร้านนี้');
    await audit(c, m, 'account.disable', 'account', String(id), 'ร้านลบบัญชีรับเงินผ่าน API (inactive)');
    return { success: true };
  });
}

// ---------- webhooks ----------

export async function webhooks(m) {
  const { rows } = await query(
    `SELECT id, url, events, status, secret_prefix AS "secretPrefix", created_at AS "createdAt" FROM webhook_endpoints WHERE merchant_id = $1 ORDER BY id`,
    [m.id],
  );
  return { success: true, data: rows.map((w) => ({ ...w, id: String(w.id), status: w.status.toUpperCase() })) };
}

export function addWebhook(m, b) {
  return withTransaction(async (c) => {
    const { rows: n } = await c.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE merchant_id = $1', [m.id]);
    if (n[0].n >= 5) throw new ApiError(400, 'TOO_MANY_WEBHOOKS', 'เพิ่ม webhook ได้สูงสุด 5 ปลายทาง');
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const { rows } = await c.query(
      `INSERT INTO webhook_endpoints (merchant_id, url, events, secret_prefix, secret_hash, secret_enc, rotated_at) VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
      [m.id, b.url, b.events, `${secret.slice(0, 12)}…`, sha(secret), seal(secret)],
    );
    await audit(c, m, 'merchant.webhook', 'merchant', m.slug, `เพิ่ม webhook ผ่าน API → ${b.url}`);
    return { success: true, webhook: { id: String(rows[0].id), url: b.url, events: b.events, status: 'ACTIVE', secret } };
  });
}

// ---------- balance / profile / dashboard ----------

export async function balance(m) {
  const [b, limits] = await Promise.all([balances({ query }, m), configOf('limits')]);
  return {
    success: true,
    balance: b.balance, availableBalance: b.available, reserved: b.reserved, currency: 'THB',
    minBalance: b.minBalance, minDepositAmount: Number(limits.minDeposit), minWithdrawAmount: Number(limits.minWithdraw),
  };
}

export async function lineSummary(m) {
  const b = await balances({ query }, m);
  // This system has no parent/child shop hierarchy: the line is the shop itself.
  return { success: true, parent: { id: String(m.id), name: m.name, balance: b.balance }, children: [], total: b.balance, currency: 'THB' };
}

export const profile = (m) => ({
  success: true,
  merchant: {
    id: String(m.id), name: m.name, slug: m.slug, status: m.status.toUpperCase(), kycStatus: m.kyc_status,
    feePercent: Number(m.fee_percent), feeFlat: Number(m.fee_flat), contactEmail: m.contact_email, contactPhone: m.contact_phone, createdAt: m.created_at,
  },
});

export async function dashboard(m) {
  await expireDue();
  const { rows } = await query(
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok' AS start)
     SELECT count(*) FILTER (WHERE p.status = 'approved' AND p.completed_at >= day.start)::int AS paid_today,
            coalesce(sum(p.amount) FILTER (WHERE p.status = 'approved' AND p.completed_at >= day.start), 0) AS paid_amount_today,
            coalesce(sum(p.fee) FILTER (WHERE p.status = 'approved' AND p.completed_at >= day.start), 0) AS fee_today,
            count(*) FILTER (WHERE p.status = 'pending')::int AS pending,
            count(*) FILTER (WHERE p.created_at >= day.start)::int AS created_today
       FROM payments p, day WHERE p.merchant_id = $1`,
    [m.id],
  );
  const { rows: out } = await query(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, coalesce(sum(amount) FILTER (WHERE status = 'approved' AND completed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'), 0) AS paid_today
       FROM outflows WHERE merchant_id = $1`,
    [m.id],
  );
  const b = await balances({ query }, m);
  const r = rows[0];
  return {
    success: true,
    today: { paidCount: r.paid_today, paidAmount: Number(r.paid_amount_today), fee: Number(r.fee_today), createdCount: r.created_today, payoutAmount: Number(out[0].paid_today) },
    pending: { payments: r.pending, payouts: out[0].pending },
    balance: b.balance, availableBalance: b.available,
  };
}

// ---------- merchant login (issues an API key) ----------

/** Permissions of a shop-user level, from Settings (console_config.merchantPerms). */
export async function permsForTier(tier) {
  const matrix = await configOf('merchantPerms');
  return matrix[tier] ?? [];
}
export const permissionLabel = (code) => MERCHANT_PERMISSIONS.find((p) => p.code === code)?.label ?? code;

/** Check a portal user's password (with lockout). Returns the user row joined with the shop. */
export async function verifyPortalUser(b, ip) {
  const who = b.email ?? b.username;
  const { rows } = await query(
    `SELECT u.*, m.name AS merchant_name, m.slug, m.status AS merchant_status, m.contact_email
       FROM merchant_portal_users u JOIN merchants m ON m.id = u.merchant_id
      WHERE lower(u.email) = $1 OR u.username = $1 ORDER BY (lower(u.email) = $1) DESC LIMIT 1`,
    [who],
  );
  const u = rows[0];
  const ok = await verifyPassword(b.password, u?.password_hash);
  const fail = new ApiError(401, 'INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  if (!u) throw fail;
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new ApiError(423, 'ACCOUNT_LOCKED', 'บัญชีถูกล็อกชั่วคราวเพราะใส่รหัสผิดหลายครั้ง — ลองใหม่ภายหลัง', { lockedUntil: u.locked_until });
  if (!ok) {
    await query(
      `UPDATE merchant_portal_users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' END WHERE id = $1`,
      [u.id],
    );
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail, ip) VALUES ($1, 'auth.merchant_login_failed', 'merchant', $2, 'รหัสผ่านไม่ถูกต้อง', $3)`, [u.username, u.slug, ip ?? null]);
    throw fail;
  }
  if (u.status !== 'active' || u.merchant_status !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'บัญชีหรือร้านค้านี้ถูกปิดใช้งาน');
  await query('UPDATE merchant_portal_users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  return u;
}

const SECRET_PREFIX = 'sk_live_';
const loginFail = () => new ApiError(401, 'INVALID_SECRET_KEY', 'secretKey ไม่ถูกต้องหรือถูกยกเลิกแล้ว');

/** Shop user (joined with the shop) for a secret key; 401 when unknown or revoked. */
async function verifySecretKey(raw, ip) {
  if (!raw.startsWith(SECRET_PREFIX)) throw loginFail();
  const { rows } = await query(
    `SELECT u.*, m.name AS merchant_name, m.slug, m.status AS merchant_status
       FROM merchant_portal_users u JOIN merchants m ON m.id = u.merchant_id
      WHERE u.secret_key_hash = $1`,
    [sha(raw)],
  );
  const u = rows[0];
  if (!u) {
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail, ip) VALUES ('unknown', 'auth.merchant_login_failed', 'merchant', $1, 'secretKey ไม่ถูกต้อง', $2)`, [raw.slice(0, 12), ip ?? null]);
    throw loginFail();
  }
  if (u.status !== 'active' || u.merchant_status !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'บัญชีหรือร้านค้านี้ถูกปิดใช้งาน');
  await query('UPDATE merchant_portal_users SET secret_key_last_used_at = now(), last_login_at = now() WHERE id = $1', [u.id]);
  return u;
}

export async function login(b, ip) {
  const u = await verifySecretKey(b.secretKey, ip);
  return withTransaction(async (c) => {
    const raw = await issueLoginKey(c, u);
    await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail, ip) VALUES ($1, 'auth.merchant_login', 'merchant', $2, 'เข้าสู่ระบบผ่าน API ด้วย secret key — ออก key ใหม่', $3)`, [u.username, u.slug, ip ?? null]);
    return {
      apiKey: raw,
      merchant: { id: String(u.merchant_id), username: u.username, email: u.email, businessName: u.merchant_name, status: 'ACTIVE' },
      role: 'MERCHANT',
      tier: u.tier,
      permissions: await permsForTier(u.tier),
    };
  });
}

/**
 * The user's API key (same as POST /auth/login returns): earlier login-issued keys
 * are revoked (portal keys are untouched). Stored hashed for lookup and sealed for "ดู".
 */
export async function issueLoginKey(c, u) {
  await revokeLoginKeys(c, u);
  const raw = `ak_live_${randomBytes(32).toString('base64url')}`;
  await c.query(`INSERT INTO merchant_api_keys (merchant_id, label, key_prefix, key_hash, created_by, source, portal_user_id, key_sealed) VALUES ($1, $2, $3, $4, $5, 'login', $6, $7)`, [
    u.merchant_id, `login:${u.username}`, `${raw.slice(0, 12)}…`, sha(raw), u.username, u.id, seal(raw),
  ]);
  return raw;
}

const revokeLoginKeys = (c, u) => c.query(
  `UPDATE merchant_api_keys SET status = 'revoked' WHERE merchant_id = $1 AND source = 'login' AND status = 'active' AND (portal_user_id = $3 OR label = $2)`,
  [u.merchant_id, `login:${u.username}`, u.id],
);

async function portalUser(c, m, userId) {
  const { rows } = await c.query('SELECT * FROM merchant_portal_users WHERE id = $1 AND merchant_id = $2', [userId, m.id]);
  if (!rows[0]) throw new ApiError(404, 'USER_NOT_FOUND', 'ไม่พบผู้ใช้');
  return rows[0];
}

/** The shop user's secret key status (never the key itself). */
/** "ms_live_Qziz••••••••QDp4": first 12 + last 4 (prefix only for keys stored before encryption). */
const maskKey = (sealed, prefix) => {
  if (!sealed) return prefix;
  const raw = unseal(sealed);
  return `${raw.slice(0, 12)}••••••••${raw.slice(-4)}`;
};

/** The API key the user's latest /auth/login issued (still active), if any. */
async function latestLoginKey(u) {
  const { rows } = await query(
    `SELECT key_prefix, key_sealed, created_at, last_used_at FROM merchant_api_keys
      WHERE merchant_id = $1 AND portal_user_id = $2 AND source = 'login' AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [u.merchant_id, u.id],
  );
  return rows[0] ?? null;
}

/** The shop user's secret key and latest login API key, masked (never in full here). */
export async function secretKeyInfo(m, userId) {
  const u = await portalUser({ query }, m, userId);
  const k = await latestLoginKey(u);
  return {
    secretKey: u.secret_key_hash ? { masked: maskKey(u.secret_key_sealed, u.secret_key_prefix), revealable: !!u.secret_key_sealed, createdAt: u.secret_key_created_at, lastUsedAt: u.secret_key_last_used_at } : null,
    apiKey: k ? { masked: maskKey(k.key_sealed, k.key_prefix), revealable: !!k.key_sealed, createdAt: k.created_at, lastUsedAt: k.last_used_at } : null,
  };
}

export const revealSchema = z.object({ login: z.string().trim().toLowerCase().min(1).max(200), password: z.string().min(1).max(200) });

/**
 * Full secret key + latest login API key, only after the signed-in user re-enters
 * their own login and password (wrong attempts count toward the usual lockout).
 */
export async function revealKeys(m, userId, b, ip) {
  const who = await verifyPortalUser(b.login.includes('@') ? { email: b.login, password: b.password } : { username: b.login, password: b.password }, ip);
  if (who.id !== userId || who.merchant_id !== m.id) throw new ApiError(403, 'NOT_YOUR_ACCOUNT', 'ใส่ชื่อผู้ใช้และรหัสผ่านของบัญชีที่กำลังเข้าสู่ระบบอยู่เท่านั้น');
  const u = await portalUser({ query }, m, userId);
  const k = await latestLoginKey(u);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail, ip) VALUES ($1, 'merchant.secret_key_view', 'merchant', $2, 'ดู secret key / API key แบบเต็ม (ยืนยันรหัสผ่านแล้ว)', $3)`, [u.username, m.slug, ip ?? null]);
  return {
    secretKey: u.secret_key_sealed ? unseal(u.secret_key_sealed) : null,
    apiKey: k?.key_sealed ? unseal(k.key_sealed) : null,
  };
}

/**
 * Create or replace the shop user's secret key; returned once. Replacing it also
 * revokes the API keys the old secret key logged in with.
 */
export const createSecretKey = (m, userId) => withTransaction(async (c) => {
  const u = await portalUser(c, m, userId);
  const raw = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  const prefix = `${raw.slice(0, 12)}…`;
  const { rows } = await c.query(
    `UPDATE merchant_portal_users SET secret_key_hash = $2, secret_key_prefix = $3, secret_key_sealed = $4, secret_key_created_at = now(), secret_key_last_used_at = NULL
      WHERE id = $1 RETURNING secret_key_created_at`,
    [u.id, sha(raw), prefix, seal(raw)],
  );
  // Its API key comes with it (no need to call /auth/login first); the old one is revoked.
  const apiKey = await issueLoginKey(c, u);
  await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'merchant.secret_key', 'merchant', $2, $3)`,
    [u.username, m.slug, u.secret_key_hash ? 'สร้าง secret key ใหม่ + API key (ยกเลิกอันเดิม)' : 'สร้าง secret key + API key']);
  return { secretKey: raw, apiKey, prefix, createdAt: rows[0].secret_key_created_at };
});

/** Remove the shop user's secret key and the API keys it logged in with. */
export const revokeSecretKey = (m, userId) => withTransaction(async (c) => {
  const u = await portalUser(c, m, userId);
  await c.query('UPDATE merchant_portal_users SET secret_key_hash = NULL, secret_key_prefix = NULL, secret_key_sealed = NULL, secret_key_created_at = NULL, secret_key_last_used_at = NULL WHERE id = $1', [u.id]);
  await revokeLoginKeys(c, u);
  await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'merchant.secret_key', 'merchant', $2, 'ยกเลิก secret key')`, [u.username, m.slug]);
  return { success: true };
});

/**
 * Resolve an X-API-Key to its merchant (null when unknown, revoked, the shop is
 * not active, or the key's shop user is disabled). `keyTier` is the level of the
 * shop user the key was issued to; null = shop-level key with full access.
 */
export async function merchantForKey(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('ak_live_') || raw.length > 200) return null;
  const { rows } = await query(
    `UPDATE merchant_api_keys k SET last_used_at = now() FROM merchants m
      WHERE k.key_hash = $1 AND k.status = 'active' AND m.id = k.merchant_id
      RETURNING m.*, k.portal_user_id AS key_portal_user_id, k.signing_secret_sealed AS key_signing_sealed`,
    [sha(raw)],
  );
  const m = rows[0];
  if (m?.status !== 'active') return null;
  // The secret that signs this key's requests (never sent): the shop key's own, or its user's secret key.
  const { key_signing_sealed: shopSecret, ...shop } = m;
  if (m.key_portal_user_id == null) return { ...shop, keyTier: null, keyUser: null, signingSecret: shopSecret ? unseal(shopSecret) : null };
  const { rows: u } = await query('SELECT username, tier, status, secret_key_sealed FROM merchant_portal_users WHERE id = $1', [m.key_portal_user_id]);
  if (u[0]?.status !== 'active') return null;
  return { ...shop, keyTier: u[0].tier, keyUser: u[0].username, signingSecret: u[0].secret_key_sealed ? unseal(u[0].secret_key_sealed) : null };
}

/** Throws 403 unless the key may use `perm` (shop-level keys may do everything). */
export async function requirePermission(m, perm) {
  if (!m.keyTier) return;
  if ((await permsForTier(m.keyTier)).includes(perm)) return;
  throw new ApiError(403, 'PERMISSION_DENIED', `ผู้ใช้ระดับ ${m.keyTier} ไม่มีสิทธิ์: ${permissionLabel(perm)}`, { required: perm, tier: m.keyTier });
}

export { hashPassword };

export const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(8).max(100) });

/** Portal user changes their own password. */
export async function changePortalPassword(m, userId, b) {
  const { rows } = await query('SELECT id, username, password_hash FROM merchant_portal_users WHERE id = $1 AND merchant_id = $2', [userId, m.id]);
  if (!rows[0]) throw new ApiError(404, 'USER_NOT_FOUND', 'ไม่พบผู้ใช้');
  if (!(await verifyPassword(b.current, rows[0].password_hash))) throw new ApiError(400, 'INVALID_PASSWORD', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  await query('UPDATE merchant_portal_users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(b.next)]);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'merchant.portal_password', 'merchant', $2, 'เปลี่ยนรหัสผ่าน portal')`, [rows[0].username, m.slug]);
  return { success: true };
}
