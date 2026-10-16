import { z } from 'zod';
import { query } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { BALANCE_SQL } from '../shared/balance-sql.js';

/**
 * แดชบอร์ดร้านค้า break-downs (admin): every transaction behind a card, with the same filters and formulas
 * the cards and the shop balance use, so the first number always leads exactly to the last.
 */
export const windowQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

const cents = (v) => Math.round(Number(v ?? 0) * 100);
const baht = (c) => (c / 100).toFixed(2);

async function shop(id) {
  const { rows } = await query(
    `SELECT m.id, m.name, m.slug, m.fee_percent, m.fee_flat, m.out_fee_percent, m.out_fee_flat, m.opening_balance, ${BALANCE_SQL} AS balance
       FROM merchants m WHERE m.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`Merchant ${id} does not exist`);
  return rows[0];
}

/** Red arrow: ยอดรับชำระ (gross) → ยอดสุทธิเข้าร้าน (net) — approved payments created in the window. */
export async function paymentsBreakdown(id, { from = null, to = null }) {
  const m = await shop(id);
  const { rows } = await query(
    `SELECT ref, merchant_order_id AS "orderId", customer_name AS "customer", created_at AS "createdAt", completed_at AS "approvedAt", amount, fee
       FROM payments
      WHERE merchant_id = $1 AND status = 'approved'
        AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at, id`,
    [id, from, to],
  );
  let gross = 0; let fee = 0;
  const list = rows.map((r, i) => {
    const a = cents(r.amount); const f = cents(r.fee);
    gross += a; fee += f;
    return { no: i + 1, ref: r.ref, orderId: r.orderId, customer: r.customer, createdAt: r.createdAt, approvedAt: r.approvedAt,
      amount: baht(a), fee: baht(f), net: baht(a - f), cumulativeNet: baht(gross - fee) };
  });
  return {
    shop: { id: m.id, name: m.name, feePercent: Number(m.fee_percent), feeFlat: Number(m.fee_flat) },
    window: { from, to },
    rows: list,
    totals: { count: list.length, gross: baht(gross), fee: baht(fee), net: baht(gross - fee) },
  };
}

/**
 * Blue arrow: ยอดสุทธิเข้าร้านสะสม (all time) → ยอดคงเหลือถอนได้ (now). Same pieces as BALANCE_SQL:
 * opening balance + Σ(payment amount − fee) − Σ(outflow amount + fee) + credit adjustments + commission from sub-shops.
 */
export async function balanceBreakdown(id) {
  const m = await shop(id);
  const [{ rows: pay }, { rows: outs }, { rows: adj }, { rows: com }] = await Promise.all([
    query(`SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS gross, coalesce(sum(fee), 0) AS fee FROM payments WHERE merchant_id = $1 AND status = 'approved'`, [id]),
    query(
      `SELECT ref, merchant_ref AS "merchantRef", source, receiver_name AS "receiverName", receiver_bank_code AS "bankCode", receiver_account AS "account",
              created_at AS "createdAt", completed_at AS "approvedAt", admin_done AS "transferred", admin_done_at AS "transferredAt", amount, fee
         FROM outflows WHERE merchant_id = $1 AND status = 'approved' ORDER BY created_at, id`,
      [id],
    ),
    query(`SELECT id, amount, reason, created_at AS "createdAt" FROM merchant_credit_adjustments WHERE merchant_id = $1 ORDER BY created_at, id`, [id]),
    query(
      `SELECT coalesce((SELECT sum(s.amount) FROM fee_splits s JOIN payments p ON s.source_kind = 'payment' AND p.id = s.source_id WHERE s.merchant_id = $1 AND p.status = 'approved'), 0)
            + coalesce((SELECT sum(s.amount) FROM fee_splits s JOIN outflows o ON s.source_kind = 'outflow' AND o.id = s.source_id WHERE s.merchant_id = $1 AND o.status = 'approved'), 0) AS total`,
      [id],
    ),
  ]);
  const opening = cents(m.opening_balance);
  const netIn = cents(pay[0].gross) - cents(pay[0].fee);
  let running = opening + netIn;
  let outAmount = 0; let outFee = 0;
  const payouts = outs.map((o, i) => {
    const a = cents(o.amount); const f = cents(o.fee);
    const before = running; running -= a + f; outAmount += a; outFee += f;
    return { no: i + 1, ref: o.ref, merchantRef: o.merchantRef, source: o.source, receiverName: o.receiverName, bankCode: o.bankCode, account: o.account,
      createdAt: o.createdAt, transferred: o.transferred, transferredAt: o.transferred ? o.transferredAt ?? o.approvedAt : null,
      amount: baht(a), fee: baht(f), deducted: baht(a + f), balanceBefore: baht(before), balanceAfter: baht(running) };
  });
  const adjustments = adj.map((a) => { const v = cents(a.amount); running += v; return { id: a.id, createdAt: a.createdAt, reason: a.reason, amount: baht(v), balanceAfter: baht(running) }; });
  const commission = cents(com[0].total);
  running += commission;
  const balance = cents(m.balance);
  return {
    shop: { id: m.id, name: m.name, outFeePercent: Number(m.out_fee_percent), outFeeFlat: Number(m.out_fee_flat) },
    start: { openingBalance: baht(opening), payments: pay[0].n, gross: baht(cents(pay[0].gross)), fee: baht(cents(pay[0].fee)), net: baht(netIn), startBalance: baht(opening + netIn) },
    payouts,
    adjustments,
    commission: baht(commission),
    totals: { count: payouts.length, amount: baht(outAmount), fee: baht(outFee), deducted: baht(outAmount + outFee) },
    end: { computed: baht(running), balance: baht(balance), matches: running === balance },
  };
}

// ---------- ร้านแม่–ร้านย่อย: the tree under a shop, and how each ค่าคอม is made ----------

const SRC = `LEFT JOIN payments p ON s.source_kind = 'payment' AND p.id = s.source_id
             LEFT JOIN outflows o ON s.source_kind = 'outflow' AND o.id = s.source_id`;
const SRC_IN_WINDOW = `((p.status = 'approved' AND ($2::timestamptz IS NULL OR p.created_at >= $2) AND ($3::timestamptz IS NULL OR p.created_at < $3))
                    OR (o.status = 'approved' AND ($2::timestamptz IS NULL OR o.created_at >= $2) AND ($3::timestamptz IS NULL OR o.created_at < $3)))`;

/**
 * The selected shop and every shop below it (any depth), each with its rates and the period's numbers (same filters as
 * the cards: approved, by creation time), its current balance and the ค่าคอม it earned from its own sub-shops.
 * `ancestors` = the shops above it, for the breadcrumb.
 */
export async function treeBreakdown(id, { from = null, to = null }) {
  const m = await shop(id);
  const { rows: anc } = await query(
    `SELECT a.id, a.name FROM merchants me JOIN merchants a ON a.id = ANY (me.path) WHERE me.id = $1 ORDER BY array_position(me.path, a.id)`, [id]);
  const { rows } = await query(
    `SELECT m.id, m.name, m.slug, m.status, m.parent_id AS "parentId", cardinality(m.path) - (SELECT cardinality(path) FROM merchants WHERE id = $1) AS depth,
            m.fee_percent AS "feePercent", m.fee_flat AS "feeFlat", m.out_fee_percent AS "outFeePercent", m.out_fee_flat AS "outFeeFlat",
            (SELECT count(*)::int FROM merchants c WHERE c.parent_id = m.id) AS children,
            (SELECT count(*)::int FROM payments WHERE merchant_id = m.id AND status = 'approved' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) AS "payCount",
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE merchant_id = m.id AND status = 'approved' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) AS gross,
            (SELECT coalesce(sum(fee), 0) FROM payments WHERE merchant_id = m.id AND status = 'approved' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) AS fee,
            (SELECT count(*)::int FROM outflows WHERE merchant_id = m.id AND status = 'approved' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) AS "outCount",
            (SELECT coalesce(sum(amount), 0) FROM outflows WHERE merchant_id = m.id AND status = 'approved' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) AS "outAmount",
            (SELECT coalesce(sum(fee), 0) FROM outflows WHERE merchant_id = m.id AND status = 'approved' AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)) AS "outFee",
            (SELECT coalesce(sum(s.amount), 0) FROM fee_splits s ${SRC} WHERE s.merchant_id = m.id AND ${SRC_IN_WINDOW}) AS commission,
            ${BALANCE_SQL} AS balance
       FROM merchants m
      WHERE m.id = $1 OR $1 = ANY (m.path)
      ORDER BY m.path || m.id`,
    [id, from, to],
  );
  const shops = rows.map((r) => ({ ...r, depth: Number(r.depth) }));
  // The selected shop's own parent (outside the tree): its rates are the floor when editing the selected shop's rates.
  const { rows: par } = await query(
    `SELECT p.id, p.name, p.fee_percent AS "feePercent", p.fee_flat AS "feeFlat", p.out_fee_percent AS "outFeePercent", p.out_fee_flat AS "outFeeFlat"
       FROM merchants me JOIN merchants p ON p.id = me.parent_id WHERE me.id = $1`, [id]);
  const sum = (k) => baht(shops.reduce((t, r) => t + cents(r[k]), 0));
  return {
    root: { id: m.id, name: m.name, parent: par[0] ?? null }, ancestors: anc, window: { from, to }, shops,
    totals: { shops: shops.length, gross: sum('gross'), fee: sum('fee'), outAmount: sum('outAmount'), outFee: sum('outFee'), commission: sum('commission'), balance: sum('balance') },
  };
}

/**
 * Every ค่าคอม share a shop earned in the period, one row per transaction below it: which shop's transaction, how many
 * levels down, the fee at the rate of the shop just below this one on the chain − the fee at this shop's rate.
 * Plus each sub-shop's rate gap, which explains shops that give no ค่าคอม (same rate).
 */
export async function commissionBreakdown(id, { from = null, to = null }) {
  const m = await shop(id);
  const { rows } = await query(
    `SELECT s.source_kind AS kind, coalesce(p.ref, o.ref) AS ref, coalesce(p.created_at, o.created_at) AS "createdAt",
            coalesce(p.amount, o.amount) AS base, s.amount, s.below_fee AS "belowFee", s.below_pct AS "belowPct", s.below_flat AS "belowFlat",
            s.own_fee AS "ownFee", s.own_pct AS "ownPct", s.own_flat AS "ownFlat",
            src.id AS "fromId", src.name AS "fromName", cardinality(src.path) - cardinality(me.path) AS levels,
            b.id AS "belowId", b.name AS "belowName"
       FROM fee_splits s ${SRC}
       JOIN merchants src ON src.id = s.from_merchant_id
       JOIN merchants me ON me.id = s.merchant_id
       LEFT JOIN merchants b ON b.id = coalesce(s.below_merchant_id, src.path[cardinality(me.path) + 2], src.id)
      WHERE s.merchant_id = $1 AND ${SRC_IN_WINDOW}
      ORDER BY "createdAt", s.id`,
    [id, from, to],
  );
  let total = 0;
  const shares = rows.map((r, i) => {
    total += cents(r.amount);
    return { no: i + 1, kind: r.kind === 'payment' ? 'เงินเข้า' : 'เงินออก', ref: r.ref, createdAt: r.createdAt, fromName: r.fromName, levels: Number(r.levels),
      belowName: r.belowName, base: baht(cents(r.base)), belowPct: r.belowPct, belowFee: r.belowFee, ownPct: r.ownPct, ownFee: r.ownFee, amount: baht(cents(r.amount)) };
  });
  const byLevel = {};
  for (const r of shares) {
    const k = `${r.levels}|${r.fromName}`;
    byLevel[k] ??= { levels: r.levels, fromName: r.fromName, count: 0, cents: 0 };
    byLevel[k].count += 1; byLevel[k].cents += cents(r.amount);
  }
  // Every shop below, and the shop directly under this one on its branch: this shop's ค่าคอม on that shop's transactions
  // is the gap between that shop's rate and this shop's rate (0 when equal).
  const { rows: subs } = await query(
    `SELECT c.name, cardinality(c.path) - cardinality(me.path) AS levels, v.name AS "viaName",
            v.fee_percent AS "viaIn", v.out_fee_percent AS "viaOut"
       FROM merchants me JOIN merchants c ON me.id = ANY (c.path)
       JOIN merchants v ON v.id = coalesce(c.path[array_position(c.path, me.id) + 1], c.id)
      WHERE me.id = $1 ORDER BY c.path || c.id`,
    [id],
  );
  return {
    shop: { id: m.id, name: m.name, feePercent: Number(m.fee_percent), feeFlat: Number(m.fee_flat), outFeePercent: Number(m.out_fee_percent), outFeeFlat: Number(m.out_fee_flat) },
    window: { from, to },
    shares,
    byShop: Object.values(byLevel).sort((a, b) => a.levels - b.levels || a.fromName.localeCompare(b.fromName)).map((g) => ({ levels: g.levels, fromName: g.fromName, count: g.count, amount: baht(g.cents) })),
    subShops: subs.map((c) => ({
      name: c.name, levels: Number(c.levels), viaName: c.viaName,
      inGap: Math.round((Number(c.viaIn) - Number(m.fee_percent)) * 1000) / 1000, outGap: Math.round((Number(c.viaOut) - Number(m.out_fee_percent)) * 1000) / 1000,
    })),
    total: baht(total),
  };
}
