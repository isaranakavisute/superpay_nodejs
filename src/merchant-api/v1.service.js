import { createHash, randomBytes } from 'node:crypto';
import { EVENT_CODES } from '../webhooks/events.js';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import { internal as configOf, minBalanceFor } from '../config-admin/config.service.js';
import { approveOne, emitPaymentEvent, setAmountByRef } from '../payments/payment.service.js';
import { hashPassword, verifyPassword } from '../shared/password.js';
import { normalizePromptPayId, promptPayPayload } from '../shared/promptpay.js';
import { open as unseal, seal } from '../shared/secret-box.js';
import { findReusedSlip, isSampleSlip, qrReason, SAMPLE_SLIP_MESSAGE, slipFingerprint } from '../shared/slip-fingerprint.js';
import { MERCHANT_PERMISSIONS } from './permission-catalog.js';
import { matchSlip, normalizeSlip } from './slip-match.js';
import { cancelSlipSiblings, carryOverFrom } from './slip-carry-over.js';
import { closeUsedUp, leftOf, leftoverChecks, leftoverFor, lockTransfer, openLeftoverFor, paidBy, useLeftover } from './slip-transfers.js';
import { outFeeFor } from '../shared/out-fee.js';
import { accountNumber } from '../shared/account-number.js';
import { ocrCheckSlip } from './slip-ocr.js';
import { PENDING_TEXT, verifySlip } from './slip-verify.js';
import logger from '../logger.js';
import { stopwatch, timingOf, withTiming } from '../shared/stopwatch.js';
import { BALANCE_SQL } from '../shared/balance-sql.js';
import { effectiveStatus, syncPaymentSplits, writeSplits } from '../merchants/tree.js';
import { amountRule, linkCount, refuseUnlinkWithPending, syncPrimaryShop, uniqueAmount } from '../shared/account-links.js';
import { visible } from '../shared/private-records.js';
import { checkDemoSlip, isDemoSlip } from '../demo/demo.service.js';
import { lockRefNumbers } from '../shared/ref-lock.js';

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
/** Why a slip can't go on an order any more (API ORDER_NOT_PENDING; the slip checker bot says the same). */
export const orderNotPendingText = (status) => `ออเดอร์นี้สถานะ ${STATUS[status]} แล้ว`;
const W_STATUS = { pending: 'PENDING', approved: 'APPROVED', rejected: 'REJECTED' };
const O_STATUS = { pending: 'PENDING', approved: 'COMPLETED', rejected: 'FAILED' };

// ---------- schemas ----------
const money = z.coerce.number().positive().max(10_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'ทศนิยมได้ไม่เกิน 2 ตำแหน่ง');
const orderId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:\-#/]+$/, 'orderId: ตัวอักษร ตัวเลข และ . _ : - # / เท่านั้น');
const bankCode = z.string().trim().toUpperCase().max(10);
export const createPaymentSchema = z.object({
  amount: money,
  orderId: orderId.optional(),   // the shop's own order number; left out → Option Pay generates one (OP-…)
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
  accountNumber: accountNumber('accountNumber ต้องเป็นตัวเลข 6–20 หลัก (ใส่ขีดหรือเว้นวรรคได้)'),
  accountName: z.string().trim().min(1).max(120),
  merchantRef: z.string().trim().min(1).max(64).optional(),
};
export const payoutSchema = z.object({ ...receiver, description: z.string().trim().max(200).optional() });
export const bulkPayoutSchema = z.object({ payouts: z.array(payoutSchema).min(1).max(100) });
export const withdrawalSchema = z.object({ ...receiver, note: z.string().trim().max(200).optional() });
export const accountSchema = z.object({
  type: z.enum(['BANK', 'PROMPTPAY']).default('BANK'),
  bankCode: bankCode.optional(),
  accountNumber: accountNumber().optional(),
  accountName: z.string().trim().max(120).optional(),
  promptPayId: z.string().trim().max(20).optional(),
});
export const webhookSchema = z.object({
  url: z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'webhook URL ต้องเป็น https://'),
  events: z.array(z.enum(EVENT_CODES)).min(1).max(EVENT_CODES.length).default(['payment.approved', 'payment.rejected']),
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
const expireDue = async (c = { query }) => {
  const r = await c.query(`UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now() RETURNING ref`);
  for (const { ref } of r.rows) emitPaymentEvent(c, ref, 'payment.expired');
  return r;
};

async function balances(c, m) {
  const { rows } = await c.query(
    `SELECT m.min_balance,
            ${BALANCE_SQL} AS balance,
            coalesce((SELECT sum(amount + fee) FROM outflows WHERE merchant_id = m.id AND status = 'pending'), 0)
            + coalesce((SELECT sum(amount + fee) FROM withdrawal_requests WHERE merchant_id = m.id AND status = 'pending'), 0) AS reserved
       FROM merchants m WHERE m.id = $1`,
    [m.id],
  );
  const r = rows[0];
  const min = await minBalanceFor(r.min_balance);
  return { balance: round2(r.balance), reserved: round2(r.reserved), available: round2(Number(r.balance) - Number(r.reserved)), minBalance: min };
}

/** Money leaving the shop: per-transaction minimum, then balance and minimum balance (amount + outgoing fee). */
async function checkCanPay(c, m, amount, fee = 0) {
  const limits = await configOf('limits');
  if (Number(limits.minWithdraw) > 0 && amount < Number(limits.minWithdraw)) {
    throw new ApiError(400, 'below_min_amount', `ยอดต่ำกว่ายอดถอนขั้นต่ำ ${fmt(limits.minWithdraw)} บาท`, { minAmount: Number(limits.minWithdraw) });
  }
  await c.query('SELECT 1 FROM merchants WHERE id = $1 FOR UPDATE', [m.id]); // serialise a shop's payouts
  const b = await balances(c, m);
  const debit = round2(amount + fee);
  const withFee = fee > 0 ? ` — ต้องใช้ ${fmt(debit)} บาท รวมค่าธรรมเนียม ${fmt(fee)} บาท` : '';
  if (debit > b.available) throw new ApiError(400, 'INSUFFICIENT_BALANCE', `ยอดที่ใช้ได้ไม่พอ (ใช้ได้ ${fmt(b.available)} บาท${withFee})`, { available: b.available, amount, fee, totalDebit: debit, shortBy: round2(debit - b.available) });
  if (b.minBalance > 0 && b.available - debit < b.minBalance) {
    throw new ApiError(400, 'below_min_balance', `ถอนแล้วจะเหลือต่ำกว่ายอดคงเหลือขั้นต่ำ ${fmt(b.minBalance)} บาท`,
      { minBalance: b.minBalance, available: b.available, amount, fee, totalDebit: debit, balanceAfter: round2(b.available - debit) });
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
  // Accounts linked to this shop (an account may be shared by several shops).
  const { rows: own } = await c.query(
    `SELECT ${ACCOUNT_COLS} FROM bank_accounts a JOIN banks b ON b.code = a.bank_code
       JOIN bank_account_merchants l ON l.bank_account_id = a.id AND l.merchant_id = $1
      WHERE a.status = 'active' AND a.account_type <> 'send' ORDER BY a.id`,
    [m.id],
  );
  // A sub-merchant without its own receiving account uses its nearest parent shop's accounts (the money lands in
  // the parent's account; the order and its balance belong to the sub-merchant) — before the platform's central ones.
  const { rows: inherited } = !own.length && m.path?.length
    ? await c.query(
      `WITH near AS (SELECT l.merchant_id FROM bank_account_merchants l JOIN bank_accounts x ON x.id = l.bank_account_id
                      WHERE l.merchant_id = ANY ($1::int[]) AND x.status = 'active' AND x.account_type <> 'send'
                      ORDER BY array_position($1::int[], l.merchant_id) DESC LIMIT 1)
       SELECT ${ACCOUNT_COLS} FROM bank_accounts a JOIN banks b ON b.code = a.bank_code
         JOIN bank_account_merchants l ON l.bank_account_id = a.id AND l.merchant_id = (SELECT merchant_id FROM near)
        WHERE a.status = 'active' AND a.account_type <> 'send' ORDER BY a.id`, [m.path])
    : { rows: [] };
  const { rows: central } = slip.centralReceiving && !inherited.length
    ? await c.query(`SELECT ${ACCOUNT_COLS} FROM bank_accounts a JOIN banks b ON b.code = a.bank_code
                      WHERE NOT EXISTS (SELECT 1 FROM bank_account_merchants l WHERE l.bank_account_id = a.id)
                        AND a.status = 'active' AND a.account_type <> 'send' ORDER BY a.id`)
    : { rows: [] };
  if (requested) {
    const hit = [...own, ...inherited, ...central].find((a) => a.id === requested);
    if (!hit) throw new ApiError(400, 'INVALID_BANK_ACCOUNT', `บัญชี ${requested} ใช้รับเงินให้ร้านนี้ไม่ได้`);
    return hit;
  }
  const pool = own.length ? own : inherited.length ? inherited : central;
  if (!pool.length) throw new ApiError(400, 'NO_PAYMENT_ACCOUNT', 'ร้านนี้ยังไม่มีบัญชีรับเงินที่ใช้งานได้');
  if (pool.length === 1) return pool[0];
  if (pool === central && slip.centralDistribution === 'fixed' && slip.centralFixedAccountId) {
    const fixed = pool.find((a) => a.id === Number(slip.centralFixedAccountId));
    if (fixed) return fixed;
  }
  if (pool === central && slip.centralDistribution === 'random') return pool[Math.floor(Math.random() * pool.length)];
  // auto = least received today, count = fewest orders today (Bangkok day).
  const metric = pool === central && slip.centralDistribution === 'count' ? 'count(*)' : "coalesce(sum(amount) FILTER (WHERE status = 'approved'), 0)";
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
    // orderId: the shop's own (must be unused), or — when left out — a new one generated here (never repeats).
    const generated = !b.orderId;
    if (generated) b = { ...b, orderId: await newOrderId(c, m.id) };
    const { rows: dup } = await c.query('SELECT ref FROM payments WHERE merchant_id = $1 AND merchant_order_id = $2', [m.id, b.orderId]);
    if (dup[0]) throw new ApiError(409, 'DUPLICATE_ORDER_ID', `orderId ${b.orderId} ถูกใช้แล้ว`, { ref: dup[0].ref });
    const md = b.metadata ?? {};
    // The customer still has money left from an earlier transfer (an admin approved a smaller order with it) that covers
    // this order: it is paid from that left-over at once — no transfer, no slip (see slip-transfers.js). The order goes
    // on the account the money is in, for its exact amount (no unique satang: nothing will be transferred).
    const lo = await openLeftoverFor(c, m.id, b.amount, { customer_name: md.memberName || '-', metadata: md });
    const acct = lo
      ? (await c.query(`SELECT ${ACCOUNT_COLS} FROM bank_accounts a JOIN banks b ON b.code = a.bank_code WHERE a.id = $1`, [lo.bank_account_id])).rows[0]
      : await pickAccount(c, m, b.bankAccountId);
    // Unique satang: per setting, and always on a shared account (the amount is what tells its shops' orders apart).
    const rule = lo ? null : await amountRule(c, acct.id, slip);
    const amount = !lo && unique && rule.unique ? await uniqueAmount(c, acct.id, b.amount, rule.maxSatang, rule.cooldown) : b.amount;
    const fee = round2((amount * Number(m.fee_percent)) / 100 + Number(m.fee_flat));
    const { rows: bank } = md.senderBankCode ? await c.query('SELECT code FROM banks WHERE code = $1', [md.senderBankCode]) : { rows: [] };
    await lockRefNumbers(c, 'payments');
    const { rows: last } = await c.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 172800) AS n FROM payments WHERE ref ~ '^TXN[0-9]+$'`);
    const ref = `TXN${Number(last[0].n) + 1}`;
    const token = randomBytes(16).toString('hex');
    const { rows } = await c.query(
      `INSERT INTO payments (ref, merchant_id, merchant_order_id, customer_name, payer_bank_code, payer_account_masked, bank_account_id, amount, fee, commission,
                             status, source, checkout_token, description, expires_at, metadata, requested_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13,
               CASE WHEN $14::int > 0 THEN now() + make_interval(mins => $14::int) END, $15, $16)
       RETURNING *`,
      [ref, m.id, b.orderId, md.memberName || '-', bank[0]?.code ?? null, md.senderAccountNumber ? `···${md.senderAccountNumber.slice(-4)}` : null, acct.id, amount, fee,
        round2(fee * 0.05), source, token, b.description ?? null, slip.orderTtlMinutes, b.metadata ? JSON.stringify(b.metadata) : null, b.amount],
    );
    await syncPaymentSplits(c, rows[0].id);
    await audit(c, m, 'payment.create', 'payment', ref, `สร้างออเดอร์ผ่าน ${source === 'portal' ? 'Merchant Portal' : 'API'} ยอด ${fmt(amount)} บาท (${b.orderId})`, actor);
    if (!lo) return { success: true, orderIdGenerated: generated, transaction: present({ ...rows[0], promptpay_id: acct.promptpay_id }, base), selectedAccount: presentAccount(acct) };
    const paid = await paidBy(c, lo.id);
    const use = await useLeftover(c, lo, rows[0].id, amount, actorOf(m));
    const note = `ชำระจากยอดคงเหลือของการโอน ${fmt(lo.amount)} บาท (ชำระ ${paid.map((x) => `${x.ref} ${fmt(x.amount)} บาท`).join(', ')} แล้ว) — ไม่ต้องโอน/ส่งสลิป · คงเหลืออีก ${fmt(Number(use.transfer.amount) - Number(use.transfer.used))} บาท`;
    await approveOne(c, ref, 'system', note);
    for (const s of await closeUsedUp(c, use, rows[0].id)) {
      if (s.was === 'pending') emitPaymentEvent(c, s.ref, 'payment.rejected');
      await audit(c, m, 'payment.auto_cancel', 'payment', s.ref, `ปิดอัตโนมัติ — เงินโอนใช้ครบแล้ว (ล่าสุด ${ref})`);
    }
    await audit(c, m, 'payment.leftover', 'payment', ref, note);
    const { rows: now } = await c.query(`${PAY_SELECT} WHERE p.id = $1`, [rows[0].id]);
    return {
      success: true, orderIdGenerated: generated, transaction: present(now[0], base), selectedAccount: presentAccount(acct),
      result: 'PAID', message: `ออเดอร์ชำระแล้ว (อนุมัติอัตโนมัติ) — ${note}`,
      leftover: { transferAmount: Number(lo.amount), leftBefore: leftOf(lo), leftAfter: round2(Number(use.transfer.amount) - Number(use.transfer.used)),
        paidOrders: paid.map((x) => ({ id: x.ref, orderId: x.orderId ?? null, amount: x.amount })) },
    };
  });
}

/**
 * The checks returned to the caller, in order: bank verification, the order match (amount, transfer time,
 * receiving account, sender), slip age and duplicate use — each PASS / FAIL / WARN / UNKNOWN / SKIPPED with a reason.
 */
export function buildChecks(v, ocr, matchChecks, { carried, leftover = null, ageOk, maxAge, reusedOn, requireApproval, decision }) {
  const out = [];
  if (v.verified === true) out.push({ check: 'BANK_VERIFICATION', status: 'PASS', detail: `ธนาคารยืนยันว่ามีการโอนจริง (${v.provider})${v.transRef ? ` · เลขอ้างอิง ${v.transRef}` : ''}` });
  else if (v.verified === false) out.push({ check: 'BANK_VERIFICATION', status: 'FAIL', detail: v.message ?? 'ธนาคารไม่พบรายการโอนนี้ / สลิปไม่ถูกต้อง' });
  else out.push({ check: 'BANK_VERIFICATION', status: 'UNKNOWN', detail: 'ตรวจกับธนาคารไม่ได้ในขณะนี้ — อ่านข้อมูลจากภาพสลิปแทน (ไม่อนุมัติอัตโนมัติ รอเจ้าหน้าที่ยืนยัน)' });
  for (const x of matchChecks) {
    if (x.check === 'TRANSFER_TIME' && x.status === 'FAIL' && carried) {
      out.push({ check: 'TRANSFER_TIME', status: 'PASS', detail: `${x.detail} — แต่เป็นเงินโอนของออเดอร์ก่อนหน้า ${carried.ref} ที่ยังไม่ได้ชำระ (ลูกค้าคนเดียวกัน) จึงใช้แทนได้` });
    } else out.push(x);
  }
  if (ocr) {
    for (const t of ocr.problems ?? []) out.push({ check: 'IMAGE_READ', status: 'FAIL', detail: t });
    for (const t of ocr.flags ?? []) out.push({ check: 'IMAGE_READ', status: 'UNKNOWN', detail: t });
    if (ocr.matched?.length) out.push({ check: 'IMAGE_READ', status: 'PASS', detail: `อ่านจากภาพ ตรงกับออเดอร์: ${ocr.matched.join(', ')}` });
  }
  if (v.verified === true) out.push(ageOk ? { check: 'SLIP_AGE', status: 'PASS', detail: carried ? 'อยู่ในช่วง 24 ชั่วโมงของเงินโอนจากออเดอร์ก่อนหน้า' : leftover ? 'ยอดคงเหลือยังอยู่ในเวลาที่ใช้ได้' : `ไม่เก่าเกิน ${maxAge ?? '-'} ชั่วโมง` }
    : { check: 'SLIP_AGE', status: 'FAIL', detail: `สลิปเก่าเกิน ${maxAge} ชั่วโมง` });
  out.push(reusedOn ? { check: 'DUPLICATE', status: 'FAIL', detail: 'สลิป / เงินโอนนี้ถูกใช้ชำระรายการอื่นแล้ว — ใช้ซ้ำไม่ได้' }
    : leftover ? { check: 'DUPLICATE', status: 'PASS', detail: `เงินโอนนี้ใช้ชำระ ${leftover.paid.map((x) => x.ref).join(', ')} ไปบางส่วน — ออเดอร์นี้ใช้ยอดคงเหลือ (เหลืออีก ${fmt(leftover.after)} บาท)` }
    : { check: 'DUPLICATE', status: 'PASS', detail: 'สลิปและเงินโอนนี้ยังไม่เคยใช้ชำระรายการอื่น' });
  if (requireApproval && decision === 'review') out.push({ check: 'APPROVAL', status: 'UNKNOWN', detail: 'ตั้งค่าให้เจ้าหน้าที่ยืนยันทุกสลิปก่อนอนุมัติ' });
  return out;
}

/** What the slip itself says (from the bank via the slip provider); null when the bank could not be asked. */
export function slipDetails(v) {
  if (v.verified !== true) return null;
  const s = normalizeSlip(v.provider, v.raw) ?? {};
  return {
    provider: v.provider, transRef: v.transRef ?? null, amount: Number(v.amount), transferredAt: v.date ?? null,
    sender: { name: s.senderNames?.[0] ?? null, bank: s.senderBank ?? null, account: s.senderAccount ?? null },
    receiver: { name: s.receiverNames?.[0] ?? null, bank: s.receiverBank ?? null, account: s.receiverAccount ?? s.receiverProxy ?? null },
  };
}

/** What the caller should do now. */
export function nextStepFor(decision, { carryOver, autoCancelled }) {
  if (decision === 'approve') {
    const extra = [carryOver ? `บันทึกว่าออเดอร์นี้ชำระด้วยเงินโอนของ ${carryOver.fromRef}` : null,
      autoCancelled.length ? `อัปเดตออเดอร์ ${autoCancelled.map((x) => x.ref).join(', ')} เป็นยกเลิกในระบบของร้าน` : null].filter(Boolean);
    return `ไม่ต้องทำอะไรเพิ่ม — ออเดอร์ชำระแล้ว ส่งสินค้า/บริการได้${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
  }
  if (decision === 'review') return 'รอเจ้าหน้าที่ตรวจสลิป — ยังไม่ต้องส่งสินค้า/บริการ ระบบจะแจ้ง webhook payment.approved / payment.rejected เมื่อมีผล';
  return 'สลิปไม่ผ่าน — แจ้งลูกค้าตามข้อที่ FAIL ใน checks แล้วแนบสลิปที่ถูกต้องใหม่ (ออเดอร์ยังรอชำระ) · ถ้าลูกค้าโอนยอดไม่ตรง สร้างออเดอร์ใหม่ตามยอดที่โอนจริงแล้วแนบสลิปเดิมได้';
}

const thTime = (d) => new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
/** The approved slip's message: plain, or explaining a carry-over and the orders closed with it. */
export function approvedMessage(carryOver, autoCancelled, warn, leftover = null) {
  const parts = ['ตรวจสลิปผ่าน — ออเดอร์ชำระแล้ว (อนุมัติอัตโนมัติ)'];
  if (leftover) {
    parts.push(`ใช้ยอดคงเหลือ ${fmt(leftover.left)} บาท ของการโอน ${fmt(leftover.transferAmount)} บาท (ชำระ ${leftover.paid.map((x) => `${x.ref} ${fmt(x.amount)} บาท`).join(', ')} แล้ว) — คงเหลืออีก ${fmt(leftover.after)} บาท · ลูกค้าคนเดียวกัน บัญชีผู้รับเดียวกัน`);
  }
  if (carryOver) {
    parts.push(`ใช้เงินโอน ${fmt(carryOver.transferAmount)} บาท (โอนเมื่อ ${thTime(carryOver.transferredAt)}) จากออเดอร์ก่อนหน้า ${carryOver.fromRef}${carryOver.fromOrderId ? ` (${carryOver.fromOrderId})` : ''} ยอด ${fmt(carryOver.fromAmount)} บาท ที่ยังไม่ได้ชำระ — ลูกค้าคนเดียวกัน บัญชีผู้รับเดียวกัน`);
  }
  for (const x of autoCancelled) parts.push(`ยกเลิก ${x.ref}${x.orderId ? ` (${x.orderId})` : ''} อัตโนมัติ — ${x.reason}`);
  return parts.join(' · ') + warn;
}

/** A new orderId for a shop that did not send one: OP- + time (base36) + 10 random hex — unique, and checked. */
async function newOrderId(c, merchantId) {
  for (let i = 0; i < 5; i++) {
    const id = `OP-${Date.now().toString(36).toUpperCase()}-${randomBytes(5).toString('hex').toUpperCase()}`;
    const { rows } = await c.query('SELECT 1 FROM payments WHERE merchant_id = $1 AND merchant_order_id = $2', [merchantId, id]);
    if (!rows.length) return id;
  }
  throw new ApiError(500, 'ORDER_ID_GENERATION_FAILED', 'สร้าง orderId ไม่สำเร็จ — ลองใหม่อีกครั้ง');
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

/** Background re-checks of a slip the bank was still processing: due after 1, 3 and 6 minutes. */
const RECHECK_AFTER_MIN = [1, 2, 3];

/**
 * THE slip decision for one order — used by the merchant API (attachAndVerify, which then stores and approves) and by
 * the Telegram slip checker (which only reports), so both always apply the same rules and say the same thing.
 * `c`: a client in a transaction (transfers / earlier orders are locked FOR UPDATE; the bot rolls back).
 * `v`: verifySlip() result (v.message already set for slip_pending); `ocr`: ocrCheckSlip() result or null.
 * Returns { decision: 'approve' | 'review' | 'invalid', reason, mismatches, warnings, checks, carried, leftover,
 * combined, reusedOn, paidRequested }. Nothing is written.
 */
/**
 * Problems in the order of how decisively they block a slip (agreed 17 Oct 2026: the สถานะ column shows only the
 * first): the money went to another account › wrong amount › transferred before the order › slip too old › the rest.
 */
const WEIGHT = [/โอนเข้าธนาคาร|บัญชีผู้รับ|ชื่อผู้รับ|ต้องโอนเข้า/, /ยอดเงิน|ยอดคงเหลือ|ยอด /, /ก่อนสร้างรายการ|ก่อนสร้างออเดอร์/, /สลิปเก่า|วันเดียวกับ/];
export function byWeight(problems) {
  const rank = (t) => { const i = WEIGHT.findIndex((re) => re.test(t)); return i < 0 ? WEIGHT.length : i; };
  return [...problems].sort((a, b) => rank(a) - rank(b));
}

export async function decideSlip(c, p, v, fp, ocr) {
  // One transfer pays one order: the same slip (file or bank QR) already on another order is refused.
  let reusedOn = await findReusedSlip(c, p.id, fp);
  let decision = 'review';
  let reason = v.message ?? null;
  let mismatches = [];
  let warnings = [];
  let carried = null;   // the earlier unpaid order of the same customer whose transfer pays this one
  let checks = [];      // each check and its outcome, returned to the caller
  let ageOkFinal = true;
  let paidRequested = false; // slip pays the shop's amount without the added satang
  let leftover = null;  // this order is paid from what is left of a transfer that already paid another order
  let leftoverHint = null; // the transfer is used, but a new order of its left-over amount could use it
  let combined = null;  // the slip is short of the order and the customer's left-over pays the difference
  if (v.verified === false) {
    decision = 'invalid';
    if (/QR/.test(reason ?? '') && qrReason(fp)) reason = qrReason(fp);
    mismatches = [reason];
  }
  else if (v.verified) {
    const ageOk = !v.cfg.slipAgeCheck || !v.date || (v.cfg.slipMaxAgeHours === 0
      ? new Date(v.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) === new Date(p.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
      : Date.now() - new Date(v.date).getTime() <= v.cfg.slipMaxAgeHours * 3_600_000);
    // Amount, receiver account/bank, sender name and transfer time must all fit this order.
    const m2 = matchSlip(v, p);
    checks = m2.checks;
    paidRequested = m2.paidRequested;
    ageOkFinal = ageOk;
    const { unknown } = m2;
    let { problems } = m2;
    warnings = m2.warnings;
    // A transfer that already paid (part of) an order: only its exact left-over may pay this one — see slip-transfers.js.
    const t = await lockTransfer(c, v.transRef);
    const lo = leftoverFor(t, p, normalizeSlip(v.provider, v.raw));
    if (lo?.ok) {
      leftover = { ...lo, transferAmount: Number(t.amount), paid: await paidBy(c, t.id) };
      // The left-over covers the order: the rest of the match (receiver, sender) as if the slip were for this amount;
      // the transfer predates this order by design.
      const m3 = matchSlip({ ...v, amount: Number(p.amount) }, p);
      problems = m3.problems.filter((x) => x !== m3.early);
      checks = leftoverChecks(m3.checks, leftover, v);
      warnings = m3.warnings;
      paidRequested = false;
    } else if (lo) {
      reusedOn = reusedOn ?? (await paidBy(c, t.id))[0]?.ref ?? 'อื่น';
      leftoverHint = lo.hint ?? null;
    } else if (!t && Number(v.amount) < Number(p.amount) - 0.009) {
      // A new transfer SHORT of the order: the same customer's open left-over may pay the difference
      // (฿300 slip + ฿200 left-over = ฿500). The rest of the match as if the slip were for the full amount.
      const short = round2(Number(p.amount) - Number(v.amount));
      const cover = await openLeftoverFor(c, p.merchant_id, short, p, normalizeSlip(v.provider, v.raw));
      if (cover) {
        combined = { cover, short, slipAmount: Number(v.amount), leftBefore: leftOf(cover), paid: await paidBy(c, cover.id) };
        const m3 = matchSlip({ ...v, amount: Number(p.amount) }, p);
        problems = m3.problems;
        warnings = m3.warnings;
        paidRequested = false;
        checks = m3.checks.map((x) => (x.check === 'AMOUNT'
          ? { ...x, status: 'PASS', detail: `ยอดในสลิป ${fmt(v.amount)} บาท + ยอดคงเหลือของลูกค้า ${fmt(short)} บาท (จากการโอน ${fmt(cover.amount)} บาท ที่ชำระ ${combined.paid.map((y) => y.ref).join(', ')} แล้ว) = ${fmt(p.amount)} บาท ตรงกับยอดออเดอร์` }
          : x));
      }
    }
    // Transfer made before this order: accepted only as a carry-over from the same customer's earlier unpaid
    // order (and then the 24-hour carry-over window replaces the slip-age setting).
    if (!leftover && !combined && m2.early && problems.length === 1 && (carried = await carryOverFrom(c, p, v))) problems = [];
    // "Transferred before this order" is not the real reason when the same customer had an earlier unpaid order the
    // transfer was for (a carry-over case): what actually blocks it (e.g. paid into the shop's other account) is
    // the only reason shown (agreed 17 Oct 2026).
    else if (!leftover && !combined && m2.early && problems.length > 1 && problems.includes(m2.early)
      && (await carryOverFrom(c, p, v, { anyAccount: true }))) problems = problems.filter((x) => x !== m2.early);
    if (!ageOk && !carried && !leftover) problems.push(v.cfg.slipMaxAgeHours === 0 ? 'สลิปต้องเป็นการโอนวันเดียวกับที่สร้างรายการ' : `สลิปเก่าเกิน ${v.cfg.slipMaxAgeHours} ชั่วโมง — ใช้สลิปเก่าไม่ได้`);
    // สถานะ is straight to the point: the one reason that really blocks the slip; every problem stays in mismatches / checks.
    if (problems.length) { decision = 'invalid'; mismatches = byWeight(problems); reason = mismatches[0]; }
    else {
      if (v.transRef && !leftover) {
        const { rows } = await c.query('SELECT p.ref FROM payment_slips s JOIN payments p ON p.id = s.payment_id WHERE s.trans_ref = $1 AND s.payment_id <> $2', [v.transRef, p.id]);
        if (rows[0]) reusedOn ??= rows[0].ref;
      }
      if (unknown.length) { decision = 'review'; reason = `${unknown.join(' · ')} — รอผู้ดูแลตรวจ`; }
      else if (v.cfg.requireApproval) { decision = 'review'; reason = 'สลิปถูกต้อง — รอผู้ดูแลยืนยัน (ตั้งค่า "ต้องให้ผู้ดูแลยืนยันก่อน")'; }
      else decision = 'approve';
      // e.g. paid by someone other than the customer: kept on the order for the shop to see.
      if (carried) {
        const was = carried.status === 'rejected' ? 'ยกเลิก' : carried.status === 'pending' && (!carried.expires_at || new Date(carried.expires_at) > new Date()) ? 'ยังเปิดอยู่ — ยกเลิกอัตโนมัติ' : 'หมดอายุ';
        const note = `ใช้เงินโอนจากออเดอร์ก่อนหน้า ${carried.ref} (${was}) — โอน ${new Date(v.date).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })}`;
        reason = decision === 'approve' ? note : `${reason} · ${note}`;
      }
      if (combined) {
        const note = `โอน ${fmt(combined.slipAmount)} บาท + ใช้ยอดคงเหลือ ${fmt(combined.short)} บาท จากการโอน ${fmt(combined.cover.amount)} บาท (ชำระ ${combined.paid.map((x) => `${x.ref} ${fmt(x.amount)} บาท`).join(', ')} แล้ว) = ${fmt(p.amount)} บาท · ยอดคงเหลือเหลืออีก ${fmt(combined.leftBefore - combined.short)} บาท`;
        reason = decision === 'approve' ? note : `${reason} · ${note}`;
      }
      if (leftover) {
        const note = `ใช้ยอดคงเหลือของการโอน ${fmt(leftover.transferAmount)} บาท (ชำระ ${leftover.paid.map((x) => `${x.ref} ${fmt(x.amount)} บาท`).join(', ')} แล้ว) — ออเดอร์นี้ ${fmt(p.amount)} บาท คงเหลืออีก ${fmt(leftover.after)} บาท`;
        reason = decision === 'approve' ? note : `${reason} · ${note}`;
      }
      // Sender-name warnings stay in the checks, not in an approved order's note (user's rule, 22 Oct 2026).
      const shown = warnings.filter((w) => !/ผู้โอน/.test(w));
      if (shown.length) reason = decision === 'approve' ? `${carried || leftover || combined ? reason : 'ตรวจสลิปผ่าน'} · ⚠️ ${shown.join(' · ')}` : reason;   // waiting for an admin: the main reason only (warnings are in checks)
    }
  } else if (ocr) {
    // Pixels can be edited: numbers that clearly differ reject; a match still needs the admin.
    if (ocr.problems.length) { decision = 'invalid'; mismatches = byWeight(ocr.problems); reason = mismatches[0]; }
    else reason = [ocr.matched.length ? `ตรงกับรายการ: ${ocr.matched.join(', ')}` : null, ...ocr.flags].filter(Boolean).join(' · ') + ' — อ่านจากภาพสลิป รอผู้ดูแลยืนยัน';
  }
  // The other order's ref is kept for the admin (it may belong to another shop), not shown to the uploader.
  // A different photo / the same image of a transfer paying this order from its left-over is not a reuse.
  if (leftover) reusedOn = null;
  if (reusedOn) { decision = 'invalid'; reason = `สลิปนี้ถูกใช้กับรายการอื่นแล้ว — ใช้ซ้ำไม่ได้${leftoverHint ? ` · ${leftoverHint}` : ''}`; mismatches = [reason]; }
  checks = buildChecks(v, ocr, checks, { carried, leftover, ageOk: ageOkFinal || !!carried || !!leftover, maxAge: v.cfg?.slipMaxAgeHours, reusedOn, requireApproval: v.cfg?.requireApproval, decision });
  return { decision, reason, mismatches, warnings, checks, carried, leftover, combined, reusedOn, paidRequested };
}

/**
 * `once`: refuse when an accepted / in-review slip is already attached (customer checkout page).
 * `recheck`: a background re-check of the stored slip (n = which one); the provider is asked once, without waiting.
 */
async function attachAndVerify(m, p, { image, mime }, base, { once = false, recheck = 0, actor = null } = {}) {
  // Who attached it: the shop's API key, or an admin uploading in the console (same check, their name on the record).
  const who = actor ?? actorOf(m);
  const buf = Buffer.from(image, 'base64');
  if (buf.length < 100 || buf.length > 8 << 20) throw new ApiError(400, 'INVALID_SLIP', 'ไฟล์สลิปต้องเป็นรูปขนาดไม่เกิน 8 MB');
  if (!['pending', 'expired'].includes(p.status)) throw new ApiError(409, 'ORDER_NOT_PENDING', orderNotPendingText(p.status));
  if (once && (await hasAcceptedSlip({ query }, p.id))) throw slipTaken();
  const time = stopwatch();
  const fp = await slipFingerprint(buf, mime);
  time.lap('qr', 'อ่าน QR จากภาพ');
  if (isSampleSlip(fp)) throw new ApiError(400, 'SAMPLE_SLIP', SAMPLE_SLIP_MESSAGE);
  if (isDemoSlip(fp)) return demoSlipApprove(m, p, buf, mime, fp, base, time, who);
  const v = await verifySlip(buf, mime, { pendingRetries: !recheck });
  time.lap('provider', `ตรวจกับธนาคาร (${v.provider})`);
  // Rule (17 Oct 2026): "not found" usually means a slip sent too soon after the transfer — re-check it a few times
  // (like slip_pending) before it counts as a bad slip; only after the last re-check is it refused.
  const notFoundRetry = v.verified === false && v.notFound && recheck < RECHECK_AFTER_MIN.length;
  if (notFoundRetry) Object.assign(v, { verified: null, pending: true });
  // Rule (21 Oct 2026, TXN177859 / TXN178099): the provider gave NO definite answer (error, timeout, quota) — ask it
  // again after 1, 3 and 6 minutes before falling back to reading the image (OCR) and handing the slip to an admin.
  const providerRetry = v.verified === null && !v.pending && v.provider && v.provider !== 'none' && recheck < RECHECK_AFTER_MIN.length;
  if (providerRetry) Object.assign(v, { pending: true });
  // No definite answer from a provider (none connected / down, or still none after the re-checks): read the slip image itself.
  // Not while the bank is still processing the transfer — the slip is re-checked with the provider instead.
  const ocr = v.verified === null && !v.pending ? await ocrCheckSlip(buf, p, v.cfg) : null;
  const nextRecheck = v.pending && recheck < RECHECK_AFTER_MIN.length ? RECHECK_AFTER_MIN[recheck] : null;
  if (v.pending) {
    v.message = notFoundRetry ? 'ธนาคารยังไม่พบรายการโอนนี้ (อาจเพิ่งโอน) — ระบบจะตรวจซ้ำอัตโนมัติ'
      : providerRetry ? 'ยังตรวจสลิปกับธนาคารไม่สำเร็จ (ระบบตรวจสลิปไม่ตอบชั่วคราว) — ระบบจะตรวจซ้ำอัตโนมัติ'
      : nextRecheck ? PENDING_TEXT : 'ธนาคารยังประมวลผลรายการโอนนี้อยู่ (EasySlip: slip_pending) หลังตรวจซ้ำครบแล้ว — รอผู้ดูแลตรวจ';
  }
  if (ocr) time.lap('ocr', 'อ่านข้อความจากภาพ');
  const via = ocr ? 'ocr' : v.provider;
  const out = await withTransaction(async (c) => {
    // Re-read under the lock: the same slip sent twice at once (TXN179275, 22 Oct 2026) — the first request approved the
    // order while this one was checking; this one must not overwrite its slip and note with "ใช้ซ้ำไม่ได้".
    const { rows: [cur] } = await c.query('SELECT status FROM payments WHERE id = $1 FOR UPDATE', [p.id]);
    if (!['pending', 'expired'].includes(cur.status)) throw new ApiError(409, 'ORDER_NOT_PENDING', orderNotPendingText(cur.status));
    if (once && (await hasAcceptedSlip(c, p.id))) throw slipTaken();
    const d = await decideSlip(c, p, v, fp, ocr);
    const { decision, reason, mismatches, carried, leftover, combined, reusedOn, paidRequested } = d;
    // Auto-approved: exactly like a normal approval — a sender name that differs from the customer's (someone else may pay
    // for them) is no warning in the note, the stored result or the API reply (user's rule, 22 Oct 2026).
    const senderOk = (x) => decision === 'approve' && /ผู้โอน/.test(x);
    const warnings = d.warnings.filter((w) => !senderOk(w));
    const checks = d.checks.map((x) => (x.check === 'SENDER_NAME' && x.status === 'WARN' && decision === 'approve' ? { ...x, status: 'PASS', detail: 'ผ่าน' } : x));
    let carryOver = null; // what the caller is told about it
    const autoCancelled = [];   // other orders of this shop closed because this slip paid this order
    await c.query(
      `INSERT INTO payment_slips (payment_id, mime, data, uploaded_by, provider, trans_ref, verify_result, image_sha256, qr_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (payment_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now(),
         provider = EXCLUDED.provider, trans_ref = EXCLUDED.trans_ref, verify_result = EXCLUDED.verify_result,
         image_sha256 = EXCLUDED.image_sha256, qr_payload = EXCLUDED.qr_payload`,
      [p.id, mime, buf, who, via, (decision === 'approve' || decision === 'review') && !leftover ? v.transRef ?? null : null,
        JSON.stringify({ verified: v.verified, amount: v.amount ?? null, date: v.date ?? null, transRef: v.transRef ?? null, message: reason, decision, mismatches, warnings, ocr, carriedFrom: carried && !reusedOn ? carried.ref : null, leftoverOf: leftover ? leftover.paid.map((x) => x.ref) : null, coverTransferId: combined && decision !== 'invalid' ? combined.cover.id : null }), fp.sha256, fp.qr],
    );
    await c.query('UPDATE payments SET slip_received_at = now(), review_note = coalesce($2, review_note), slip_reused_ref = $3 WHERE id = $1', [p.id, reason, reusedOn]);
    // Still being processed by the bank: schedule the next background check (none once the slip has an answer).
    await c.query(`UPDATE payment_slips SET recheck_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + make_interval(mins => $2::int) END,
                          recheck_attempts = $3 WHERE payment_id = $1`, [p.id, decision === 'review' ? nextRecheck : null, recheck]);
    const warn = warnings.length ? ` · ⚠️ ${warnings.join(' · ')}` : '';
    // The earlier order keeps its status; its note says which order its transfer paid.
    if (carried && !reusedOn && decision !== 'invalid') {
      // A still-open earlier order is closed once the new one is approved: its transfer went to the new order.
      const close = decision === 'approve' && carried.status === 'pending';
      const { rowCount } = close
        ? await c.query(`UPDATE payments SET status = 'rejected', completed_at = now(), reviewed_by = 'system', review_note = $2 WHERE id = $1 AND status = 'pending'`,
          [carried.id, `ยกเลิกอัตโนมัติ — ลูกค้าชำระผ่าน ${p.ref} แทน (เงินโอนของออเดอร์นี้ใช้ชำระ ${p.ref} แล้ว)`])
        : decision === 'approve' && carried.status === 'expired'
          // Already expired: close it too, so it leaves รอตรวจสอบ (it has a slip) — no callback, the shop saw it expire.
          ? await c.query(`UPDATE payments SET status = 'rejected', completed_at = now(), reviewed_by = 'system', review_note = $2 WHERE id = $1 AND status = 'expired'`,
            [carried.id, `ปิดรายการ — เงินโอนของออเดอร์นี้ใช้ชำระ ${p.ref} แล้ว (carry-over) · ไม่มีการเติมเงินจากออเดอร์นี้`]).then(() => ({ rowCount: 0 }))
          : await c.query(`UPDATE payments SET review_note = $2 WHERE id = $1`, [carried.id, `เงินโอนของออเดอร์นี้ใช้ชำระ ${p.ref} แล้ว`]);
      if (close && rowCount) emitPaymentEvent(c, carried.ref, 'payment.rejected');
      carryOver = {
        fromRef: carried.ref, fromOrderId: carried.merchant_order_id ?? null, fromAmount: Number(carried.amount),
        fromStatus: close && rowCount ? 'CANCELLED_AUTOMATICALLY' : carried.status === 'rejected' ? 'CANCELLED' : 'EXPIRED',
        transferAmount: Number(v.amount), transferredAt: v.date,
        reason: 'เงินโอนนี้เกิดขึ้นหลังสร้างออเดอร์ก่อนหน้าของลูกค้าคนเดียวกัน (บัญชีผู้รับเดียวกัน) ซึ่งยังไม่ได้ชำระ และยังไม่เคยใช้ชำระออเดอร์ใด จึงใช้ชำระออเดอร์นี้แทน',
      };
      if (close && rowCount) autoCancelled.push({ ref: carried.ref, orderId: carried.merchant_order_id ?? null, amount: Number(carried.amount), reason: `ลูกค้าชำระผ่าน ${p.ref} แทน (ใช้เงินโอนเดียวกัน)` });
      await audit(c, m, 'payment.carry_over', 'payment', carried.ref,
        `เงินโอน ${fmt(v.amount)} บาท ของ ${carried.ref} ใช้ชำระ ${p.ref}${close && rowCount ? ' — ยกเลิก ' + carried.ref + ' อัตโนมัติ' : ''}`, who);
    }
    // Unique satang were added but the customer paid the amount the shop asked for (bank-verified): the order is for that.
    if (decision === 'approve' && paidRequested) await setAmountByRef(c, p.ref, Number(v.amount), 'system', 'ลูกค้าโอนตามยอดที่ร้านสั่ง (ไม่รวมสตางค์ที่ระบบเติม) — ธนาคารยืนยันแล้ว');
    if (decision === 'approve') {
      await approveOne(c, p.ref, 'system', (carried && !reusedOn) || leftover || combined ? `ตรวจสลิปผ่าน ${v.provider} · ${reason}` : `ตรวจสลิปผ่าน ${v.provider}${warn}`,
        { cover: combined?.cover ?? null });
    }
    // The same slip refused earlier on another still-open order of this shop: that order is closed now.
    if (decision === 'approve') {
      for (const s of await cancelSlipSiblings(c, p, fp)) {
        emitPaymentEvent(c, s.ref, 'payment.rejected');
        await audit(c, m, 'payment.auto_cancel', 'payment', s.ref, `ยกเลิกอัตโนมัติ — สลิปเดียวกันใช้ชำระ ${p.ref} แทน`, who);
        autoCancelled.push({ ref: s.ref, orderId: s.merchant_order_id ?? null, amount: Number(s.amount), reason: `สลิปเดียวกันเคยไม่ผ่านในออเดอร์นี้ และใช้ชำระ ${p.ref} แล้ว` });
      }
    }
    await audit(c, m, recheck ? 'payment.slip_recheck' : 'payment.slip', 'payment', p.ref,
      `${recheck ? `ตรวจสลิปซ้ำอัตโนมัติ ครั้งที่ ${recheck}` : actor ? 'ผู้ดูแลแนบสลิป' : 'แนบสลิป'} · ${via}: ${decision === 'approve' ? `ผ่าน — อนุมัติอัตโนมัติ${warn}` : reason ?? decision}`, who);
    const { rows } = await c.query(`${PAY_SELECT} WHERE p.id = $1`, [p.id]);
    return {
      success: decision !== 'invalid',
      verified: decision === 'approve',
      result: decision === 'approve' ? 'PAID' : decision === 'invalid' ? 'INVALID_SLIP' : 'PENDING_REVIEW',
      message: decision === 'approve' ? approvedMessage(carryOver, autoCancelled, warn, leftover) + (combined ? ` · ${reason}` : '') : reason,
      mismatches,
      warnings,
      carriedFrom: carried && !reusedOn && decision !== 'invalid' ? carried.ref : null,
      carryOver,
      leftover: leftover && decision !== 'invalid'
        ? { transferAmount: leftover.transferAmount, leftBefore: leftover.left, leftAfter: leftover.after, paidOrders: leftover.paid.map((x) => ({ id: x.ref, orderId: x.orderId ?? null, amount: x.amount })) }
        : combined && decision !== 'invalid'
          ? { combined: true, slipAmount: combined.slipAmount, fromLeftover: combined.short, transferAmount: Number(combined.cover.amount),
            leftBefore: combined.leftBefore, leftAfter: round2(combined.leftBefore - combined.short),
            paidOrders: combined.paid.map((x) => ({ id: x.ref, orderId: x.orderId ?? null, amount: x.amount })) }
          : null,
      autoCancelled,
      checks,
      slip: slipDetails(v),
      nextStep: nextStepFor(decision, { carryOver, autoCancelled }),
      transaction: present(rows[0], base),
    };
  });
  time.lap('db', 'บันทึกผล');
  logger.info({ ref: p.ref, via, result: out.result, ms: time.ms }, 'slip checked');
  return withTiming(out, time);
}

/** A DEMO slip from optionpay.co/demo (demo/demo.service.js): approved at once when valid for this order, else refused. */
async function demoSlipApprove(m, p, buf, mime, fp, base, time, who = actorOf(m)) {
  const bad = await checkDemoSlip(m, p, fp.qr);
  if (bad) throw new ApiError(400, 'INVALID_SLIP', bad);
  const note = 'ตรวจสลิปผ่าน — สลิป DEMO (หน้า optionpay.co/demo) · อนุมัติอัตโนมัติ';
  const out = await withTransaction(async (c) => {
    await c.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE', [p.id]);
    await c.query(
      `INSERT INTO payment_slips (payment_id, mime, data, uploaded_by, provider, trans_ref, verify_result, image_sha256, qr_payload) VALUES ($1, $2, $3, $4, 'demo', NULL, $5, $6, $7)
       ON CONFLICT (payment_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now(),
         provider = EXCLUDED.provider, trans_ref = NULL, verify_result = EXCLUDED.verify_result, image_sha256 = EXCLUDED.image_sha256, qr_payload = EXCLUDED.qr_payload`,
      [p.id, mime, buf, who, JSON.stringify({ verified: true, amount: Number(p.amount), message: note, decision: 'approve', demo: true }), fp.sha256, fp.qr],
    );
    await c.query('UPDATE payments SET slip_received_at = now(), review_note = $2 WHERE id = $1', [p.id, note]);
    await approveOne(c, p.ref, 'system', note);
    await audit(c, m, 'payment.slip', 'payment', p.ref, `แนบสลิป · demo: ผ่าน — อนุมัติอัตโนมัติ (สลิป DEMO)`, who);
    const { rows } = await c.query(`${PAY_SELECT} WHERE p.id = $1`, [p.id]);
    return {
      success: true, verified: true, result: 'PAID', message: 'สลิป DEMO ถูกต้อง — อนุมัติรายการอัตโนมัติ (เฉพาะหน้า demo)',
      mismatches: [], warnings: [], carriedFrom: null, carryOver: null, leftover: null, autoCancelled: [],
      slip: { provider: 'demo', amount: Number(p.amount) }, nextStep: nextStepFor('approve', { carryOver: null, autoCancelled: [] }),
      transaction: present(rows[0], base),
    };
  });
  time.lap('db', 'บันทึกผล');
  logger.info({ ref: p.ref, via: 'demo', result: out.result, ms: time.ms }, 'slip checked');
  return withTiming(out, time);
}

export async function createSlipPayment(m, b, { base }) {
  const created = await createPayment(m, b, { base, source: 'slip', unique: false });
  // Already paid from the customer's left-over: no slip to check.
  if (!b.image || created.result === 'PAID') return created;
  const p = await payByToken({ query }, m, created.transaction.id);
  return attachAndVerify(m, p, { image: b.image, mime: b.mime ?? 'image/jpeg' }, base);
}

export async function verifyByOrder(m, b, { base }) {
  await expireDue();
  const { rows } = await query(`${PAY_SELECT} WHERE p.merchant_id = $1 AND p.merchant_order_id = $2`, [m.id, b.orderId]);
  if (!rows[0]) throw new ApiError(404, 'ORDER_NOT_FOUND', `ไม่พบ orderId ${b.orderId}`);
  return attachAndVerify(m, rows[0], b, base);
}

/**
 * Admin console: a slip uploaded on an order runs the SAME automatic check as the API (bank check, amount / account /
 * time, reuse, carry-over) and is approved at once when it passes (20 Oct 2026) — recorded under the admin's name.
 * Orders already approved / rejected / refunded just store the image (evidence; no re-check).
 */
export async function adminAttachSlip(ref, actor, { image, mime }) {
  await expireDue();
  const { rows: [p] } = await query(`${PAY_SELECT} WHERE p.ref = $1`, [ref]);
  if (!p) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  if (!['pending', 'expired'].includes(p.status)) return { checked: false, status: p.status };
  const { rows: [m] } = p.merchant_id ? await query('SELECT * FROM merchants WHERE id = $1', [p.merchant_id]) : { rows: [{ id: null, slug: 'house' }] };
  const r = await attachAndVerify(m, p, { image, mime }, null, { actor: actor ?? 'console' });
  return { checked: true, result: r.result, verified: r.verified, message: r.message, mismatches: r.mismatches, warnings: r.warnings,
    autoCancelled: r.autoCancelled, carriedFrom: r.carriedFrom, nextRecheck: r.result === 'PENDING_REVIEW' ? r.nextStep : null };
}

export async function attachByRef(m, ref, b, { base }) {
  await expireDue();
  return attachAndVerify(m, await payByToken({ query }, m, ref), b, base);
}

export async function byOrder(m, id, { base }) {
  await expireDue();
  // Deleted orders are not shown to the shop (user, 25 Oct 2026).
  const { rows } = await query(`${PAY_SELECT} WHERE p.merchant_id = $1 AND p.merchant_order_id = $2 AND p.deleted_at IS NULL`, [m.id, id]);
  if (!rows[0]) throw new ApiError(404, 'ORDER_NOT_FOUND', `ไม่พบ orderId ${id}`);
  return { success: true, transaction: present(rows[0], base) };
}

/** Public: what the customer checkout page needs (no key; the token is the secret). */
export async function checkout(token, { base }) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  await expireDue();
  const { rows } = await query(`${PAY_SELECT.replace('SELECT p.*', 'SELECT p.*, m.name AS merchant_name')} JOIN merchants m ON m.id = p.merchant_id WHERE p.checkout_token = $1 AND p.deleted_at IS NULL`, [token]);
  const p = rows[0];
  if (!p) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  const t = present(p, base);
  return {
    success: true,
    transaction: { id: t.id, orderId: t.orderId, amount: t.amount, status: t.status, description: t.description, qrExpiry: t.qrExpiry, createdAt: t.createdAt, paidAt: t.paidAt, copy: t.copy, paymentMethod: t.paymentMethod },
    // Set only for orders made with POST /api/v2/payment/create + return_url: the checkout page sends the customer there.
    ...(p.return_url ? { returnUrl: p.return_url, ref: p.ref } : {}),
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
  const { rows } = await query(`${PAY_SELECT.replace('SELECT p.*', 'SELECT p.*, m.slug, m.id AS mid')} JOIN merchants m ON m.id = p.merchant_id WHERE p.checkout_token = $1 AND p.deleted_at IS NULL`, [token]);
  if (!rows[0]) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'ไม่พบรายการ');
  const r = await attachAndVerify({ id: rows[0].mid, slug: `${rows[0].slug}:checkout` }, rows[0], b, base, { once: true });
  return withTiming({ success: r.success, verified: r.verified, result: r.result, message: r.message, mismatches: r.mismatches, status: r.transaction.status }, timingOf(r));
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
  // Private test records never show in the portal lists (they stay reachable by ref through the API).
  const where = `p.merchant_id = $1 AND p.deleted_at IS NULL AND ($2::text[] IS NULL OR p.status = ANY ($2)) AND ($3::timestamptz IS NULL OR p.created_at >= $3) AND ($4::timestamptz IS NULL OR p.created_at < $4) AND ${visible('payment', 'p.ref')}`;
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
  id: o.ref, merchantRef: o.merchant_ref, amount: Number(o.amount), fee: Number(o.fee), totalDebit: round2(Number(o.amount) + Number(o.fee)), status: O_STATUS[o.status], bankCode: o.receiver_bank_code,
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
    if (rows[0]) throw new ApiError(409, 'DUPLICATE_MERCHANT_REF', `merchantRef ${b.merchantRef} ถูกใช้แล้ว (${rows[0].ref})`, { merchantRef: b.merchantRef, payoutId: rows[0].ref });
  }
  await requireBank(c, b.bankCode);
  const fee = outFeeFor(m, b.amount);
  await checkCanPay(c, m, b.amount, fee);
  await lockRefNumbers(c, 'outflows');
  const { rows: last } = await c.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 40100) AS n FROM outflows WHERE ref ~ '^OUT[0-9]+$'`);
  const ref = `OUT${Number(last[0].n) + 1}`;
  const { rows } = await c.query(
    // Approved at once: the shop's balance is charged now; the admin makes the bank transfer and ticks "admin ดำเนินการ".
    `INSERT INTO outflows (ref, merchant_id, category, receiver_name, receiver_bank_code, receiver_account, amount, status, source, description, merchant_ref, idempotency_key, fee, completed_at)
     VALUES ($1, $2, 'transfer', $3, $4, $5, $6, 'approved', 'api', $7, $8, $9, $10, now()) RETURNING *`,
    [ref, m.id, b.accountName, b.bankCode, b.accountNumber, b.amount, b.description ?? `Payout ผ่าน API${b.merchantRef ? ` (${b.merchantRef})` : ''}`, b.merchantRef ?? null, idem ?? null, fee],
  );
  await writeSplits(c, 'outflow', rows[0].id, m.id, b.amount, 'out');
  await audit(c, m, 'outflow.create', 'outflow', ref, `Payout ผ่าน API ${fmt(b.amount)} บาท${fee ? ` + ค่าธรรมเนียม ${fmt(fee)} บาท` : ''} → ${b.bankCode} ···${b.accountNumber.slice(-4)} — อนุมัติอัตโนมัติ (รอ admin โอน)`);
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
  const { rows } = await query(`SELECT * FROM outflows WHERE merchant_id = $1 AND deleted_at IS NULL AND ${id ? 'ref' : 'merchant_ref'} = $2`, [m.id, id ?? merchantRef]);
  if (!rows[0]) throw new ApiError(404, 'PAYOUT_NOT_FOUND', 'ไม่พบ payout');
  return { success: true, payout: presentPayout(rows[0]) };
}

export async function payouts(m, q) {
  const st = statusFilter(q.status, O_STATUS);
  const args = [m.id, st, q.from ?? null, q.to ?? null];
  const where = `merchant_id = $1 AND deleted_at IS NULL AND ($2::text[] IS NULL OR status = ANY ($2)) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4) AND ${visible('outflow', 'ref')}`;
  const [{ rows }, { rows: n }] = await Promise.all([
    query(`SELECT * FROM outflows WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${q.limit} OFFSET ${q.offset}`, args),
    query(`SELECT count(*)::int AS n FROM outflows WHERE ${where}`, args),
  ]);
  return { success: true, data: rows.map(presentPayout), pagination: { total: n[0].n, limit: q.limit, offset: q.offset } };
}

// ---------- withdrawal requests ----------

const presentWdr = (w) => ({
  requestRef: w.ref, merchantRef: w.merchant_ref, amount: Number(w.amount), fee: Number(w.fee), totalDebit: round2(Number(w.amount) + Number(w.fee)), status: W_STATUS[w.status], bankCode: w.receiver_bank_code,
  accountNumber: w.receiver_account, accountName: w.receiver_name, note: w.note, rejectReason: w.reject_reason, createdAt: w.created_at, decidedAt: w.decided_at,
});

export function createWithdrawal(m, b) {
  return withTransaction(async (c) => {
    if (b.merchantRef) {
      const { rows } = await c.query('SELECT ref FROM withdrawal_requests WHERE merchant_id = $1 AND merchant_ref = $2', [m.id, b.merchantRef]);
      if (rows[0]) throw new ApiError(409, 'DUPLICATE_MERCHANT_REF', `merchantRef ${b.merchantRef} ถูกใช้แล้ว (${rows[0].ref})`, { merchantRef: b.merchantRef, requestRef: rows[0].ref });
    }
    await requireBank(c, b.bankCode);
    const fee = outFeeFor(m, b.amount);
    await checkCanPay(c, m, b.amount, fee);
    await lockRefNumbers(c, 'withdrawal_requests');
    const { rows: last } = await c.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 90000) AS n FROM withdrawal_requests WHERE ref ~ '^WDR[0-9]+$'`);
    const ref = `WDR${Number(last[0].n) + 1}`;
    const { rows } = await c.query(
      `INSERT INTO withdrawal_requests (ref, merchant_id, receiver_name, receiver_bank_code, receiver_account, amount, note, status, merchant_ref, fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9) RETURNING *`,
      [ref, m.id, b.accountName, b.bankCode, b.accountNumber, b.amount, b.note ?? null, b.merchantRef ?? null, fee],
    );
    await writeSplits(c, 'withdrawal', rows[0].id, m.id, b.amount, 'out');
    await audit(c, m, 'withdrawal.create', 'withdrawal', ref, `คำขอถอนผ่าน API ${fmt(b.amount)} บาท${fee ? ` + ค่าธรรมเนียม ${fmt(fee)} บาท` : ''}`);
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
    `SELECT ${ACCOUNT_COLS}, a.status, (SELECT count(*) FROM bank_account_merchants x WHERE x.bank_account_id = a.id) > 1 AS shared
       FROM bank_accounts a JOIN banks b ON b.code = a.bank_code
       JOIN bank_account_merchants l ON l.bank_account_id = a.id AND l.merchant_id = $1 ORDER BY a.id`,
    [m.id],
  );
  return {
    success: true,
    // shared = also used by other shops (which ones is not shown)
    data: rows.map((a) => ({ ...presentAccount(a), status: a.status.toUpperCase(), shared: a.shared })),
    centralReceiving: slip.centralReceiving,
    note: rows.some((a) => a.status === 'active') ? null
      : m.path?.length ? 'ยังไม่มีบัญชีของร้าน — ออเดอร์จะใช้บัญชีรับเงินของร้านแม่ (ยอดยังเป็นของร้านนี้)'
        : slip.centralReceiving ? 'ยังไม่มีบัญชีของร้าน — ออเดอร์จะใช้บัญชีกลางของระบบ' : 'ยังไม่มีบัญชีรับเงิน — สร้างออเดอร์ไม่ได้จนกว่าจะเพิ่มบัญชี',
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
    // The same account already in the system: this shop's own → returned as is; another shop's or central → only the
    // admin can share it (Admin → บัญชีธนาคาร → ผูกกับร้าน).
    const { rows: same } = await c.query(
      `SELECT a.id, EXISTS (SELECT 1 FROM bank_account_merchants l WHERE l.bank_account_id = a.id AND l.merchant_id = $3) AS mine
         FROM bank_accounts a WHERE a.bank_code = $1 AND (a.account_no = $2 OR a.promptpay_id = $2) AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1`,
      [code, digits, m.id],
    );
    if (same[0] && !same[0].mine) throw new ApiError(409, 'ACCOUNT_EXISTS', 'บัญชีนี้มีอยู่ในระบบแล้ว — ติดต่อผู้ดูแลระบบเพื่อผูกบัญชีนี้กับร้านของคุณ (ใช้บัญชีร่วมกันได้)');
    if (same[0]) {
      const { rows: a } = await c.query(`SELECT ${ACCOUNT_COLS}, a.status FROM bank_accounts a JOIN banks b ON b.code = a.bank_code WHERE a.id = $1`, [same[0].id]);
      return { success: true, account: { ...presentAccount(a[0]), status: a[0].status.toUpperCase() } };
    }
    const { rows } = await c.query(
      `INSERT INTO bank_accounts (label, bank_code, account_type, status, account_name, account_no, promptpay_id, merchant_id)
       VALUES ($1, $2, 'receive', 'active', $3, $4, $5, $6) RETURNING id`,
      [`${code} ···${digits.slice(-4)}`, code, b.accountName ?? m.name, b.accountNumber ?? null, pp, m.id],
    );
    await c.query('INSERT INTO bank_account_merchants (bank_account_id, merchant_id, linked_by) VALUES ($1, $2, $3)', [rows[0].id, m.id, `api:${m.slug}`]);
    await audit(c, m, 'account.create', 'account', String(rows[0].id), `ร้านเพิ่มบัญชีรับเงินผ่าน API (${b.type})`);
    const { rows: a } = await c.query(`SELECT ${ACCOUNT_COLS}, a.status FROM bank_accounts a JOIN banks b ON b.code = a.bank_code WHERE a.id = $1`, [rows[0].id]);
    return { success: true, account: { ...presentAccount(a[0]), status: 'ACTIVE' } };
  });
}

export function removeAccount(m, id) {
  return withTransaction(async (c) => {
    const { rows: link } = await c.query('SELECT 1 FROM bank_account_merchants WHERE bank_account_id = $1 AND merchant_id = $2', [id, m.id]);
    if (!link[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'ไม่พบบัญชีของร้านนี้');
    await c.query('SELECT 1 FROM bank_accounts WHERE id = $1 FOR UPDATE', [id]);
    // Shared with other shops: only this shop leaves it (never while its orders there still wait for payment).
    if ((await linkCount(c, id)) > 1) {
      await refuseUnlinkWithPending(c, id, [m.id]);
      await c.query('DELETE FROM bank_account_merchants WHERE bank_account_id = $1 AND merchant_id = $2', [id, m.id]);
      await syncPrimaryShop(c, id);
      await audit(c, m, 'account.unlink', 'account', String(id), 'ร้านเลิกใช้บัญชีรับเงินที่ใช้ร่วม (บัญชียังใช้งานกับร้านอื่น)');
      return { success: true, unlinked: true };
    }
    await c.query(`UPDATE bank_accounts SET status = 'inactive' WHERE id = $1`, [id]);
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

/** The shop's line: itself + every sub-merchant below it (any depth), with balances. */
export async function lineSummary(m) {
  const { rows } = await query(
    `SELECT m.id, m.name, m.slug, m.parent_id, cardinality(m.path) - $2 AS depth, m.status, ${BALANCE_SQL} AS balance
       FROM merchants m WHERE m.id = $1 OR $1 = ANY (m.path) ORDER BY m.path || m.id`,
    [m.id, (m.path ?? []).length],
  );
  const [self, ...below] = rows;
  const total = round2(rows.reduce((t, r) => t + Number(r.balance), 0));
  return {
    success: true,
    parent: { id: String(self.id), name: self.name, balance: round2(self.balance) },
    children: below.map((r) => ({ id: String(r.id), name: r.name, slug: r.slug, parentId: String(r.parent_id), depth: r.depth, status: r.status.toUpperCase(), balance: round2(r.balance) })),
    total, currency: 'THB',
  };
}

/** X-Sub-Merchant: a parent shop's key acting for a shop below it (same key, same signature, that shop's data). */
export async function actAsSubMerchant(m, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'INVALID_SUB_MERCHANT', 'X-Sub-Merchant ต้องเป็น id ของร้านย่อย (ตัวเลข)');
  if (id === Number(m.id)) return m;
  const { rows } = await query('SELECT * FROM merchants WHERE id = $1 AND $2 = ANY (path)', [id, m.id]);
  if (!rows[0]) throw new ApiError(403, 'SUB_MERCHANT_NOT_FOUND', `ร้าน ${id} ไม่ได้อยู่ใต้ร้านของ API key นี้`);
  if ((await effectiveStatus({ query }, id)) !== 'active') throw new ApiError(403, 'SUB_MERCHANT_NOT_ACTIVE', `ร้านย่อย ${rows[0].name} ยังรออนุมัติหรือถูกระงับ`);
  return { ...rows[0], keyTier: m.keyTier, keyUser: m.keyUser, signingSecret: m.signingSecret, actingParentId: m.id };
}

export const profile = (m) => ({
  success: true,
  merchant: {
    id: String(m.id), name: m.name, slug: m.slug, status: m.status.toUpperCase(), kycStatus: m.kyc_status,
    feePercent: Number(m.fee_percent), feeFlat: Number(m.fee_flat), outFeePercent: Number(m.out_fee_percent), outFeeFlat: Number(m.out_fee_flat),
    parentId: m.parent_id == null ? null : String(m.parent_id), allowSubMerchants: m.allow_sub_merchants, minBalance: Number(m.min_balance), contactEmail: m.contact_email, contactPhone: m.contact_phone, createdAt: m.created_at,
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
  // A shop waiting for approval may sign in (and see that it waits); a suspended shop — or one under a suspended shop — may not.
  if (u.status !== 'active' || (await effectiveStatus({ query }, u.merchant_id)) === 'suspended') throw new ApiError(403, 'ACCOUNT_DISABLED', 'บัญชีหรือร้านค้านี้ถูกปิดใช้งาน');
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
  if (u.status !== 'active' || (await effectiveStatus({ query }, u.merchant_id)) !== 'active') throw new ApiError(403, 'ACCOUNT_DISABLED', 'บัญชีหรือร้านค้านี้ถูกปิดใช้งาน หรือยังรอผู้ดูแลระบบอนุมัติ');
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
  if (m?.status !== 'active' || (await effectiveStatus({ query }, m.id)) !== 'active') return null;
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
  await query('UPDATE merchant_portal_users SET password_hash = $2, must_change_password = false WHERE id = $1', [userId, await hashPassword(b.next)]);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'merchant.portal_password', 'merchant', $2, 'เปลี่ยนรหัสผ่าน portal')`, [rows[0].username, m.slug]);
  return { success: true };
}

// ---------- slip re-checks (EasySlip slip_pending) ----------

/** Re-checks slips whose transfer the bank was still processing; approves them like a fresh upload once confirmed. */
export async function recheckDueSlips(limit = 5) {
  // Claim the due rows first so a slow check is never picked up twice.
  const { rows } = await query(
    `UPDATE payment_slips s SET recheck_at = NULL
      WHERE s.payment_id IN (SELECT payment_id FROM payment_slips WHERE recheck_at IS NOT NULL AND recheck_at <= now() ORDER BY recheck_at LIMIT $1)
      RETURNING s.payment_id, s.recheck_attempts`,
    [limit],
  );
  let done = 0;
  for (const r of rows) {
    try {
      const { rows: ps } = await query(`${PAY_SELECT.replace('SELECT p.*', 'SELECT p.*, m.slug')} JOIN merchants m ON m.id = p.merchant_id WHERE p.id = $1`, [r.payment_id]);
      const p = ps[0];
      if (!p || !['pending', 'expired'].includes(p.status)) continue;
      const { rows: sl } = await query('SELECT data, mime FROM payment_slips WHERE payment_id = $1', [r.payment_id]);
      if (!sl[0]) continue;
      const out = await attachAndVerify({ id: p.merchant_id, slug: `${p.slug}:recheck` }, p, { image: sl[0].data.toString('base64'), mime: sl[0].mime },
        process.env.PUBLIC_BASE_URL ?? 'https://optionpay.co', { recheck: r.recheck_attempts + 1 });
      logger.info({ ref: p.ref, attempt: r.recheck_attempts + 1, result: out.result }, 'slip re-checked');
      done += 1;
    } catch (err) {
      logger.warn({ err, paymentId: r.payment_id }, 'slip re-check failed');
    }
  }
  return done;
}

let recheckTimer = null;
export function startSlipRechecks() {
  if (recheckTimer) return;
  let busy = false;
  recheckTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await recheckDueSlips(); } catch (err) { logger.warn({ err }, 'slip re-check loop failed'); } finally { busy = false; }
  }, 20_000);
  recheckTimer.unref();
}
export function stopSlipRechecks() {
  clearInterval(recheckTimer);
  recheckTimer = null;
}
