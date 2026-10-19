import { z } from 'zod';
import { internal as configOf, notifyPaymentApproved } from '../config-admin/config.service.js';
import { emitPaymentEvent } from '../payments/payment.service.js';
import { query, withTransaction } from '../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { syncPaymentSplits } from '../merchants/tree.js';
import { lockRefNumbers } from '../shared/ref-lock.js';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const matchBodySchema = z.object({ paymentRef: z.string().regex(/^TXN\d{1,12}$/) });
export const createMatchBodySchema = z.object({
  merchantId: z.coerce.number().int().positive().nullable(),
  bankAccountId: z.coerce.number().int().positive(),
  customerName: z.string().trim().min(1).max(120),
});
export const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(300) });
export const simulateBodySchema = z.object({
  channelId: z.coerce.number().int().positive(),
  direction: z.enum(['in', 'out']).default('in'),
  sender: z.string().trim().min(1).max(120),
  amount: z.coerce.number().positive().max(10_000_000).multipleOf(0.01),
  bankAccountId: z.coerce.number().int().positive().nullable(),
  orderRef: z.string().regex(/^TXN\d{1,12}$/).optional().or(z.literal('')),
});

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'event', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lockEvent(client, id) {
  const { rows } = await client.query('SELECT * FROM inbound_events WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new NotFoundError(`Event ${id} does not exist`);
  return rows[0];
}
const requireOpen = (e) => {
  if (!['new', 'ambiguous'].includes(e.status)) throw new ConflictError(`Event ${e.id} is already ${e.status}`);
};

/** Approve `paymentRef` from this event (pending / expired orders only). */
async function approveFromEvent(client, e, ref, actor, how) {
  const { rows } = await client.query('SELECT id, status, amount, merchant_id, merchant_order_id FROM payments WHERE ref = $1 FOR UPDATE', [ref]);
  if (!rows[0]) throw new BadRequestError(`Order ${ref} does not exist`);
  if (!['pending', 'expired'].includes(rows[0].status)) throw new ConflictError(`Order ${ref} is ${rows[0].status}`);
  await client.query(`UPDATE payments SET status = 'approved', reviewed_by = $2, completed_at = now() WHERE id = $1`, [rows[0].id, actor]);
  await client.query(`UPDATE inbound_events SET status = $2, payment_ref = $3, decided_by = $4, recheck_at = NULL, note = NULL WHERE id = $1`, [
    e.id, how, ref, actor,
  ]);
  const p = rows[0];
  client.afterCommit?.(() => notifyPaymentApproved({ ref, merchantId: p.merchant_id, merchantOrderId: p.merchant_order_id, amount: p.amount, approvedBy: actor }));
  emitPaymentEvent(client, ref, 'payment.approved');
}

/**
 * The matcher: a pending order with the same amount, created within the
 * settings window (autoMatchTimeWindow hours) before the transfer, on the same
 * receiving account (when known). One → approve, several → ambiguous, none →
 * stays without an order. Off when autoMatchAmount is disabled in settings.
 */
async function autoMatch(client, e) {
  if (e.direction !== 'in' || e.amount == null) return 'skipped';
  const slip = await configOf('slip');
  if (!slip.autoMatchAmount) {
    await client.query(`UPDATE inbound_events SET status = 'new', note = 'ปิดการจับคู่อัตโนมัติไว้ในหน้าตั้งค่า — จับคู่เอง', recheck_at = NULL WHERE id = $1`, [e.id]);
    return 'unmatched';
  }
  const { rows } = await client.query(
    `SELECT ref FROM payments
      WHERE status = 'pending' AND amount = $1
        AND created_at BETWEEN $2::timestamptz - make_interval(hours => $4) AND $2::timestamptz + interval '5 minutes'
        AND ($3::int IS NULL OR bank_account_id = $3)
      ORDER BY created_at DESC LIMIT 5`,
    [e.amount, e.received_at, e.bank_account_id, slip.autoMatchTimeWindow],
  );
  if (rows.length === 1) {
    await approveFromEvent(client, e, rows[0].ref, 'system', 'matched');
    return 'matched';
  }
  const note = rows.length > 1 ? `ยอดชนหลายออเดอร์ (${rows.map((r) => r.ref).join(', ')}) — เลือกออเดอร์ให้ถูก` : 'ไม่พบออเดอร์ที่ยอดตรงกันในบัญชีนี้';
  await client.query(`UPDATE inbound_events SET status = $2, note = $3, recheck_at = NULL WHERE id = $1`, [e.id, rows.length > 1 ? 'ambiguous' : 'new', note]);
  return rows.length > 1 ? 'ambiguous' : 'unmatched';
}

export function match(id, actor, { paymentRef }) {
  return withTransaction(async (client) => {
    const e = await lockEvent(client, id);
    requireOpen(e);
    await approveFromEvent(client, e, paymentRef, actor, 'manual');
    await audit(client, actor, 'event.match', paymentRef, `จับคู่ event #${id} → ${paymentRef}`);
  });
}

/** No order exists: create one from the event and approve it. */
export function createAndMatch(id, actor, { merchantId, bankAccountId, customerName }) {
  return withTransaction(async (client) => {
    const e = await lockEvent(client, id);
    requireOpen(e);
    if (e.amount == null) throw new BadRequestError('This event has no amount');
    const { rows: m } = merchantId ? await client.query('SELECT fee_percent, fee_flat FROM merchants WHERE id = $1', [merchantId]) : { rows: [] };
    if (merchantId && !m[0]) throw new BadRequestError('Unknown merchant');
    const fee = m[0] ? Math.round((Number(e.amount) * Number(m[0].fee_percent) / 100 + Number(m[0].fee_flat)) * 100) / 100 : 0;
    await lockRefNumbers(client, 'payments');
    const { rows: last } = await client.query(`SELECT coalesce(max(substring(ref from 4)::bigint), 172800) AS n FROM payments WHERE ref ~ '^TXN[0-9]+$'`);
    const ref = `TXN${Number(last[0].n) + 1}`;
    await client.query(
      `INSERT INTO payments (ref, merchant_id, customer_name, payer_bank_code, bank_account_id, amount, fee, commission, status, reviewed_by, completed_at)
       VALUES ($1, $2, $3, (SELECT bank_code FROM bank_accounts WHERE id = $4), $4, $5, $6, round($6 * 0.05, 2), 'approved', $7, now()) RETURNING id`,
      [ref, merchantId, customerName, bankAccountId, e.amount, fee, actor],
    ).then((r) => syncPaymentSplits(client, r.rows[0].id));
    await client.query(`UPDATE inbound_events SET status = 'manual', payment_ref = $2, decided_by = $3, recheck_at = NULL, note = NULL WHERE id = $1`, [id, ref, actor]);
    await audit(client, actor, 'event.create_match', ref, `สร้าง ${ref} จาก event #${id} ยอด ${fmt(e.amount)} บาท`);
    return { ref };
  });
}

export function reject(id, actor, { reason }) {
  return withTransaction(async (client) => {
    const e = await lockEvent(client, id);
    requireOpen(e);
    await client.query(`UPDATE inbound_events SET status = 'rejected', note = $2, decided_by = $3, recheck_at = NULL WHERE id = $1`, [id, reason, actor]);
    await audit(client, actor, 'event.reject', String(id), reason);
  });
}

export function flip(id, actor) {
  return withTransaction(async (client) => {
    const e = await lockEvent(client, id);
    requireOpen(e);
    const next = e.direction === 'in' ? 'out' : 'in';
    await client.query('UPDATE inbound_events SET direction = $2 WHERE id = $1', [id, next]);
    await audit(client, actor, 'event.flip', String(id), `เปลี่ยนเป็นเงิน${next === 'in' ? 'เข้า' : 'ออก'}`);
    return { direction: next };
  });
}

export function recheck(id, actor) {
  return withTransaction(async (client) => {
    const e = await lockEvent(client, id);
    requireOpen(e);
    const result = await autoMatch(client, e);
    await audit(client, actor, 'event.recheck', String(id), `ตรวจซ้ำ: ${result}`);
    return { result };
  });
}

/** Re-run the matcher over today's open incoming events. */
export async function recheckToday(actor) {
  const { rows } = await query(
    `SELECT id FROM inbound_events WHERE status IN ('new', 'ambiguous') AND direction = 'in'
       AND (received_at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date ORDER BY id`,
  );
  const tally = { matched: 0, ambiguous: 0, unmatched: 0, skipped: 0 };
  for (const { id } of rows) {
    const r = await withTransaction(async (client) => autoMatch(client, await lockEvent(client, id)));
    tally[r] += 1;
  }
  await withTransaction((client) => audit(client, actor, 'event.recheck_today', null, JSON.stringify(tally)));
  return { checked: rows.length, ...tally };
}

/** "⚡ จำลอง event": insert an event as if a channel delivered it, then match it. */
export function simulate(actor, b) {
  return withTransaction(async (client) => {
    const { rows: ch } = await client.query('SELECT id FROM channels WHERE id = $1', [b.channelId]);
    if (!ch[0]) throw new BadRequestError('Unknown channel');
    const summary = `${b.direction === 'in' ? 'รับโอน' : 'โอนออก'} ${fmt(b.amount)} บาท ${b.direction === 'in' ? 'จาก' : 'ไปยัง'} ${b.sender} (จำลอง)`;
    const { rows } = await client.query(
      `INSERT INTO inbound_events (channel_id, sender, amount, summary, status, payment_ref, direction, bank_account_id, raw_payload)
       VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8) RETURNING *`,
      [b.channelId, b.sender, b.amount, summary, b.orderRef || null, b.direction, b.bankAccountId,
        { source: 'simulated', sender: b.sender, amount: String(b.amount), orderRef: b.orderRef || null, by: actor }],
    );
    const e = rows[0];
    const result = b.orderRef ? 'needs-review' : await autoMatch(client, e);
    await audit(client, actor, 'event.simulate', String(e.id), `จำลอง event ${fmt(b.amount)} บาท → ${result}`);
    return { id: e.id, result };
  });
}
