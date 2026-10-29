import { z } from 'zod';
import { query } from '../db/pool.js';
import { internal as configOf } from '../config-admin/config.service.js';
import { matchSlip, normalizeSlip } from './slip-match.js';
import { logEasySlipCall, verifySlip } from './slip-verify.js';
import { ApiError } from './v1.service.js';

/**
 * GET /payment/validation-report — why each order is (not) approved, with the bank's own record of every slip
 * fetched again from the slip provider (1 check per slip) and every check the system runs. Approved orders first.
 * Pick orders by `refs` (TXN… / orderId, up to 100) or `date` (created that day, Bangkok time), optionally `source`
 * (API = /payment/create, SLIP, COLLECT, PORTAL), `start_time` / `end_time` (created between, inclusive) and `batch` (a saved label).
 */
const REF = /^[A-Za-z0-9._:\-#/]{1,64}$/;
const TIME = /^(\d{2}:\d{2}(:\d{2})?|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))$/;
/** A bound as a timestamptz: a bare time is that time on `date` in Bangkok. */
const at = (t, date) => (/^\d{2}:/.test(t) ? `${date}T${t.length === 5 ? `${t}:00` : t}+07:00` : t);
export const reportQuerySchema = z.object({
  refs: z.string().trim().optional()
    .transform((s) => (s ? [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))] : undefined))
    .refine((a) => !a || (a.length <= 100 && a.every((x) => REF.test(x))), 'refs: คั่นด้วย , ไม่เกิน 100 รายการ (เลขที่ TXN… หรือ orderId)'),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'date: รูปแบบ YYYY-MM-DD (วันที่สร้างรายการ เวลาไทย)').optional(),
  // How the order was created: API = /payment/create · SLIP = /payment/slip/create · COLLECT = /collect · PORTAL = Merchant Portal
  source: z.string().trim().toUpperCase().pipe(z.enum(['API', 'SLIP', 'COLLECT', 'PORTAL'])).optional(),
  // A saved label grouping orders (set by Option Pay), e.g. batch=coffee9-2026-10-14
  batch: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/, 'batch: ตัวอักษร ตัวเลข . _ - (ไม่เกิน 64 ตัว)').optional(),
  // Created between: "HH:MM[:SS]" (Bangkok, with date) or a full ISO date-time with timezone. Both ends inclusive.
  start_time: z.string().trim().regex(TIME, 'start_time: HH:MM[:SS] (คู่กับ date) หรือ 2026-10-14T16:52:00+07:00').optional(),
  end_time: z.string().trim().regex(TIME, 'end_time: HH:MM[:SS] (คู่กับ date) หรือ 2026-10-14T17:05:00+07:00').optional(),
}).refine((q) => q.refs || q.date || q.start_time || q.batch, { message: 'ต้องระบุ refs หรือ batch หรือ date หรือ start_time', path: ['refs'] })
  .refine((q) => q.date || ![q.start_time, q.end_time].some((t) => t && /^\d{2}:/.test(t)), { message: 'start_time / end_time แบบ HH:MM ต้องใช้คู่กับ date', path: ['date'] });

const th = (d) => (d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T') + '+07:00' : null);
const b2 = (n) => Number(n).toFixed(2);
const STATUS = { approved: 'PAID', pending: 'PENDING', expired: 'EXPIRED', rejected: 'CANCELLED', refunded: 'REFUNDED' };

/** The bank's record of one slip: by the stored QR payload when there is one (works for images too small to read), else by the image. */
async function bankRecord(p, cfg) {
  try {
    if (p.qr_payload && cfg.provider === 'easyslip' && cfg.easySlipApiKey) {
      const r = await fetch(`https://developer.easyslip.com/api/v1/verify?payload=${encodeURIComponent(p.qr_payload)}`,
        { headers: { authorization: `Bearer ${cfg.easySlipApiKey}` }, signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => ({}));
      logEasySlipCall('validation_report', r.status, r.status === 200 && j.data ? 'found' : r.status === 400 || r.status === 404 ? 'not_found' : 'error');
      if (r.status === 200 && j.data) return { verified: true, provider: 'easyslip', amount: Number(j.data.amount?.amount), transRef: j.data.transRef ?? null, date: j.data.date ?? null, raw: j.data };
    }
    return await verifySlip(p.data, p.mime, { purpose: 'validation_report' });
  } catch (e) {
    return { verified: null, message: e.message };
  }
}

async function one(p, cfg) {
  const item = {
    ref: p.ref, orderId: p.merchant_order_id, customer: p.customer_name,
    decision: p.status === 'approved' ? 'APPROVED' : 'NOT_APPROVED',
    currentStatus: STATUS[p.status] ?? p.status,
    amounts: { orderAmount: Number(p.amount), fee: Number(p.fee), netAmount: Math.round((p.amount - p.fee) * 100) / 100 },
    receivingAccount: `${p.acct_bank} ${p.account_no} (${p.account_name})`,
    timeline: { orderCreated: th(p.created_at), slipUploaded: th(p.uploaded_at), approvedAt: p.status === 'approved' ? th(p.completed_at) : null, approvedBy: p.status === 'approved' ? p.reviewed_by : null },
  };
  if (!p.has_slip) {
    return { ...item, bankVerification: null, checks: [],
      reason: `No slip was sent for this order, so there is no proof of payment to verify. ${item.currentStatus === 'PENDING' ? 'The order is still waiting for payment.' : 'The order is not paid.'} A ฿${b2(p.amount)} slip sent later would be checked and approved.`,
      reason_th: `ยังไม่มีการส่งสลิปสำหรับรายการนี้ จึงไม่มีหลักฐานการชำระให้ตรวจ${item.currentStatus === 'PENDING' ? ' รายการยังรอชำระ' : ' รายการยังไม่ได้ชำระ'} · หากลูกค้าส่งสลิป ฿${b2(p.amount)} ภายหลัง ระบบจะตรวจและอนุมัติได้` };
  }
  const v = await bankRecord(p, cfg);
  const s = (v.verified === true && normalizeSlip(v.provider, v.raw)) || {};
  item.bankVerification = v.verified === true
    ? { source: p.qr_payload ? 'EasySlip (bank) — QR of the slip' : 'EasySlip (bank) — slip image', verified: true, bankReference: v.transRef, transferredAt: v.date, amount: v.amount,
      sender: { name: s.senderNames?.[0] ?? null, bank: s.senderBank ?? null, account: s.senderAccount ?? null },
      receiver: { name: s.receiverNames?.[0] ?? null, bank: s.receiverBank ?? null, account: s.receiverAccount ?? s.receiverProxy ?? null } }
    : { verified: v.verified ?? null, message: v.message ?? null };
  const m = v.verified === true ? matchSlip(v, p) : { checks: [] };
  const dup = v.transRef ? (await query(`SELECT p.ref FROM payment_slips s JOIN payments p ON p.id = s.payment_id WHERE s.trans_ref = $1 AND s.payment_id <> $2`, [v.transRef, p.id])).rows[0] : null;
  item.checks = [{ check: 'BANK_VERIFICATION', status: v.verified === true ? 'PASS' : v.verified === false ? 'FAIL' : 'UNKNOWN',
      detail: v.verified === true ? `ธนาคารยืนยันว่ามีการโอนจริง · เลขอ้างอิง ${v.transRef}` : (v.message ?? 'ตรวจกับธนาคารไม่ได้ในขณะนี้') },
    ...m.checks.map((c) => ({ ...c, detail: c.detail.replace(' — ต้องโอนตรงยอดทุกสตางค์', '') })),
    { check: 'DUPLICATE', status: dup ? 'FAIL' : 'PASS', detail: dup ? `เงินโอนนี้ถูกใช้กับ ${dup.ref} แล้ว` : 'เงินโอนนี้ไม่ได้ใช้ชำระรายการอื่น' }];
  // Approved: a sender name that differs from the customer's is no warning, like a normal approval (user's rule, 22 Oct 2026).
  if (item.decision === 'APPROVED') item.checks = item.checks.map((c) => (c.check === 'SENDER_NAME' && c.status === 'WARN' ? { ...c, status: 'PASS', detail: 'ผ่าน' } : c));
  const failed = item.checks.filter((c) => c.status === 'FAIL');
  const bv = item.bankVerification;
  if (item.decision === 'APPROVED' && bv.verified) {
    item.reason = `The bank confirmed a real transfer of ฿${b2(v.amount)} (ref ${v.transRef}) from ${bv.sender.name} (${bv.sender.bank} ${bv.sender.account}) to ${bv.receiver.name} (${bv.receiver.bank} ${bv.receiver.account}) — this order's account — at ${v.date}, after the order was created. The amount matches the order exactly and the transfer was not used for any other order. All checks passed, so it was approved.`;
    item.reason_th = `ธนาคารยืนยันการโอนจริง ฿${b2(v.amount)} (เลขอ้างอิง ${v.transRef}) จาก ${bv.sender.name} (${bv.sender.bank} ${bv.sender.account}) ไปยัง ${bv.receiver.name} (${bv.receiver.bank} ${bv.receiver.account}) ซึ่งเป็นบัญชีของรายการนี้ · โอนหลังสร้างรายการ · ยอดตรงกับรายการพอดี · ไม่เคยใช้กับรายการอื่น · ผ่านทุกข้อ จึงอนุมัติ`;
  } else if (item.decision === 'APPROVED') {
    item.reason = `Approved (by ${p.reviewed_by}). The bank could not be asked again just now: ${bv.message ?? 'no answer'}.`;
    item.reason_th = `อนุมัติแล้ว (โดย ${p.reviewed_by}) · ตอนนี้ตรวจซ้ำกับธนาคารไม่ได้: ${bv.message ?? 'ไม่มีคำตอบ'}`;
  } else if (!bv.verified) {
    item.reason = `Not approved: the bank could not confirm this slip (${bv.message ?? 'no answer'}). Without the bank's confirmation a slip is never approved automatically.`;
    item.reason_th = `ไม่อนุมัติ: ธนาคารยืนยันสลิปนี้ไม่ได้ (${bv.message ?? 'ไม่มีคำตอบ'}) · สลิปที่ธนาคารยืนยันไม่ได้จะไม่ถูกอนุมัติอัตโนมัติ`;
  } else {
    const short = Number(p.amount) - Number(v.amount);
    const only = failed.length === 1 && failed[0].check === 'AMOUNT' && short > 0;
    item.reason = `The bank confirmed a real transfer of ฿${b2(v.amount)} (ref ${v.transRef}) to ${bv.receiver.name} (${bv.receiver.bank} ${bv.receiver.account}), but: ${failed.map((f) => `${f.check} — ${f.detail}`).join(' · ')}.`
      + (only ? ` The money is in the correct account but ฿${b2(short)} short: create a ฿${b2(v.amount)} order and send the same slip (within 24 h of the transfer), edit this order to ฿${b2(v.amount)}, or collect the remaining ฿${b2(short)}.` : '');
    item.reason_th = `ธนาคารยืนยันการโอนจริง ฿${b2(v.amount)} (เลขอ้างอิง ${v.transRef}) ไปยัง ${bv.receiver.name} (${bv.receiver.bank} ${bv.receiver.account}) แต่ไม่ผ่าน: ${failed.map((f) => `${f.check} — ${f.detail}`).join(' · ')}`
      + (only ? ` · เงินเข้าบัญชีถูกต้องแต่ขาด ฿${b2(short)} — สร้างรายการ ฿${b2(v.amount)} แล้วส่งสลิปเดิม (ภายใน 24 ชม. หลังโอน) หรือแก้ยอดรายการเป็น ฿${b2(v.amount)} หรือให้ลูกค้าโอนส่วนที่ขาด` : '');
  }
  return item;
}

export async function validationReport(m, q) {
  const params = [m.id];
  let where = 'p.merchant_id = $1';
  if (q.refs) { params.push(q.refs); where += ` AND (p.ref = ANY($${params.length}) OR p.merchant_order_id = ANY($${params.length}))`; }
  if (q.date) { params.push(q.date); where += ` AND (p.created_at AT TIME ZONE 'Asia/Bangkok')::date = $${params.length}::date`; }
  if (q.source) { params.push(q.source.toLowerCase()); where += ` AND p.source = $${params.length}`; }
  if (q.batch) { params.push(q.batch); where += ` AND p.batch = $${params.length}`; }
  if (q.start_time) { params.push(at(q.start_time, q.date)); where += ` AND p.created_at >= $${params.length}::timestamptz`; }
  // An end given to the minute / second includes that whole minute / second (17:04:10 includes 17:04:10.014).
  if (q.end_time) {
    const t = q.end_time, step = /^\d{2}:\d{2}$/.test(t) || /T\d{2}:\d{2}(Z|[+-])/.test(t) ? '1 minute' : /[.]\d/.test(t) ? '0 seconds' : '1 second';
    params.push(at(t, q.date)); where += ` AND p.created_at < $${params.length}::timestamptz + interval '${step}'`;
  }
  const { rows } = await query(`SELECT p.*, a.promptpay_id, a.bank_code AS acct_bank, a.account_name, a.account_no,
      s.payment_id IS NOT NULL AS has_slip, s.mime, s.data, s.uploaded_at, s.qr_payload
    FROM payments p JOIN bank_accounts a ON a.id = p.bank_account_id LEFT JOIN payment_slips s ON s.payment_id = p.id
    WHERE ${where} ORDER BY p.created_at LIMIT 101`, params);
  if (rows.length > 100) {
    throw new ApiError(400, 'TOO_MANY_ORDERS', 'เกิน 100 รายการ — ระบุ refs หรือแบ่งช่วงวันที่');
  }
  const cfg = await configOf('slip');
  const out = [];
  for (let i = 0; i < rows.length; i += 5) out.push(...(await Promise.all(rows.slice(i, i + 5).map((p) => one(p, cfg)))));   // 5 bank checks at a time
  out.sort((a, b) => (a.decision === b.decision ? a.ref.localeCompare(b.ref) : a.decision === 'APPROVED' ? -1 : 1));
  const notFound = q.refs ? q.refs.filter((r) => !rows.some((p) => p.ref === r || p.merchant_order_id === r)) : [];
  return {
    success: true,
    report: `payment validation — ${m.name ?? m.slug}`, generatedAt: th(new Date()),
    summary: { total: out.length, approved: out.filter((x) => x.decision === 'APPROVED').length, notApproved: out.filter((x) => x.decision === 'NOT_APPROVED').length,
      notApprovedWithSlip: out.filter((x) => x.decision === 'NOT_APPROVED' && x.bankVerification).length, noSlipSent: out.filter((x) => !x.bankVerification).length, ...(notFound.length ? { notFound } : {}) },
    howVerified: "Each slip's QR code was sent to EasySlip, which returns the bank's own record of the transfer (sender, receiver, amount, time, reference) — fetched again for this report. The system then checks: the amount matches the order exactly, the receiving account is this order's account, the transfer was made after the order was created, the sender name (warning only), and that the transfer was not used for another order.",
    orders: out,
  };
}
