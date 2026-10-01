import { query } from '../db/pool.js';

// Tables from migrations/002_create_payment_tables.sql. Read-only here.
// Window params are nullable: `$n::timestamptz IS NULL` means "unbounded".
const IN_WINDOW = (col) =>
  `($1::timestamptz IS NULL OR ${col} >= $1) AND ($2::timestamptz IS NULL OR ${col} < $2)`;

export async function paymentStatusTotals(from, to) {
  const { rows } = await query(
    `SELECT status,
            count(*)::int  AS count,
            sum(amount)    AS amount,
            sum(fee)       AS fee,
            sum(commission) AS commission
       FROM payments
      WHERE ${IN_WINDOW('created_at')}
      GROUP BY status`,
    [from, to],
  );
  return rows;
}

export async function outflowStatusTotals(from, to) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS count, sum(amount) AS amount
       FROM outflows
      WHERE ${IN_WINDOW('created_at')}
      GROUP BY status`,
    [from, to],
  );
  return rows;
}

/** Live queue sizes — deliberately not windowed. */
export async function pendingCounts() {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM payments WHERE status = 'pending') AS payments,
            (SELECT count(*)::int FROM outflows WHERE status = 'pending') AS outflows`,
  );
  return rows[0];
}

export async function receivingAccountCount() {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM bank_accounts
      WHERE status = 'active' AND account_type <> 'send'`,
  );
  return rows[0].n;
}

/** Active console accounts (console_user_profiles over user_password). */
export async function userCount() {
  const { rows } = await query(`SELECT count(*)::int AS n FROM console_user_profiles WHERE status = 'active'`);
  return rows[0].n;
}

export async function recentPayments(from, to, limit) {
  const { rows } = await query(
    `SELECT p.ref,
            p.merchant_id      AS "merchantId",
            m.name             AS "merchantName",
            p.customer_name    AS "customerName",
            p.payer_bank_code  AS "payerBankCode",
            b.name             AS "payerBankName",
            p.payer_account_masked AS "payerAccountMasked",
            a.label            AS "receiveAccount",
            a.bank_code        AS "accountBankCode",
            ab.name            AS "accountBankName",
            a.account_name     AS "accountName",
            a.account_no       AS "accountNo",
            p.amount,
            p.fee,
            p.currency,
            p.status,
            p.created_at       AS "createdAt"
       FROM payments p
       LEFT JOIN merchants m ON m.id = p.merchant_id
       JOIN banks b          ON b.code = p.payer_bank_code
       JOIN bank_accounts a  ON a.id = p.bank_account_id
       JOIN banks ab         ON ab.code = a.bank_code
      WHERE ${IN_WINDOW('p.created_at')}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $3`,
    [from, to, limit],
  );
  return rows;
}

export async function recentOutflows(from, to, limit) {
  const { rows } = await query(
    `SELECT o.ref,
            o.merchant_id         AS "merchantId",
            o.category,
            a.label               AS "fromAccount",
            o.receiver_name       AS "receiverName",
            o.receiver_bank_code  AS "receiverBankCode",
            b.name                AS "receiverBankName",
            o.receiver_account    AS "receiverAccount",
            o.amount,
            o.currency,
            o.status,
            o.created_at          AS "createdAt"
       FROM outflows o
       JOIN bank_accounts a ON a.id = o.bank_account_id
       JOIN banks b         ON b.code = o.receiver_bank_code
      WHERE ${IN_WINDOW('o.created_at')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $3`,
    [from, to, limit],
  );
  return rows;
}

/**
 * One row per merchant: windowed deposit/fee/withdraw totals, plus the live
 * (all-time) balance and pending count, which have no "per window" meaning.
 */
export async function merchantStats(from, to) {
  const { rows } = await query(
    `WITH win_in AS (
       SELECT merchant_id, sum(amount) AS total, sum(fee) AS fee, count(*)::int AS n
         FROM payments
        WHERE status = 'approved' AND ${IN_WINDOW('created_at')}
        GROUP BY merchant_id
     ), win_out AS (
       SELECT merchant_id, sum(amount) AS total, count(*)::int AS n
         FROM outflows
        WHERE status = 'approved' AND ${IN_WINDOW('created_at')}
        GROUP BY merchant_id
     ), live_in AS (
       SELECT merchant_id, sum(amount - fee) AS net FROM payments
        WHERE status = 'approved' GROUP BY merchant_id
     ), live_out AS (
       SELECT merchant_id, sum(amount) AS total FROM outflows
        WHERE status = 'approved' GROUP BY merchant_id
     ), pending AS (
       SELECT merchant_id, count(*)::int AS n FROM payments
        WHERE status = 'pending' GROUP BY merchant_id
     )
     SELECT m.id,
            m.name,
            m.slug,
            m.fee_percent                                     AS "feePercent",
            m.fee_flat                                        AS "feeFlat",
            m.status,
            m.kyc_status                                      AS "kycStatus",
            m.min_balance                                     AS "minBalance",
            m.created_at                                      AS "createdAt",
            coalesce(wi.total, 0)                             AS "depositTotal",
            coalesce(wi.n, 0)                                 AS "depositCount",
            coalesce(wi.fee, 0)                               AS "feeTotal",
            coalesce(wo.total, 0)                             AS "withdrawTotal",
            coalesce(wo.n, 0)                                 AS "withdrawCount",
            m.opening_balance + coalesce(li.net, 0) - coalesce(lo.total, 0) + coalesce(adj.total, 0) AS "currentBalance",
            coalesce(adj.total, 0)                            AS "creditAdjustments",
            (SELECT count(*)::int FROM merchant_api_keys k WHERE k.merchant_id = m.id AND k.status = 'active') AS "apiKeysActive",
            (SELECT count(*)::int FROM merchant_api_keys k WHERE k.merchant_id = m.id) AS "apiKeysTotal",
            m.contact_email AS "contactEmail", m.contact_phone AS "contactPhone", m.opening_balance AS "openingBalance",
            coalesce(pe.n, 0)                                 AS "pendingCount"
       FROM merchants m
       LEFT JOIN win_in wi   ON wi.merchant_id = m.id
       LEFT JOIN win_out wo  ON wo.merchant_id = m.id
       LEFT JOIN live_in li  ON li.merchant_id = m.id
       LEFT JOIN live_out lo ON lo.merchant_id = m.id
       LEFT JOIN pending pe  ON pe.merchant_id = m.id
       LEFT JOIN (SELECT merchant_id, sum(amount) AS total FROM merchant_credit_adjustments GROUP BY merchant_id) adj ON adj.merchant_id = m.id
      ORDER BY coalesce(wi.total, 0) DESC, m.id`,
    [from, to],
  );
  return rows;
}

/** Approved payments per Bangkok day for the last `days` days, gaps filled with 0. */
export async function dailyTrend(days, merchantId = null) {
  const { rows } = await query(
    `WITH bounds AS (
       SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today
     ), series AS (
       SELECT generate_series(today - ($1::int - 1), today, interval '1 day')::date AS day
         FROM bounds
     )
     SELECT to_char(s.day, 'YYYY-MM-DD')    AS day,
            coalesce(sum(p.amount), 0)      AS amount,
            coalesce(sum(p.fee), 0)         AS fee,
            count(p.id)::int                AS count
       FROM series s
       LEFT JOIN payments p
              ON p.status = 'approved'
             AND (p.created_at AT TIME ZONE 'Asia/Bangkok')::date = s.day
             AND ($2::int IS NULL OR p.merchant_id = $2)
      GROUP BY s.day
      ORDER BY s.day`,
    [days, merchantId],
  );
  return rows;
}

/** Live work queues for the console's menu badges and bell. */
export async function queueCounts() {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM payments WHERE status = 'pending')            AS payments,
            (SELECT count(*)::int FROM outflows WHERE status = 'pending')            AS outflows,
            (SELECT count(*)::int FROM withdrawal_requests WHERE status = 'pending') AS withdrawals,
            (SELECT count(*)::int FROM double_credits WHERE status = 'open')         AS "doubleCredits",
            (SELECT count(*)::int FROM inbound_events WHERE status = 'new')          AS events`,
  );
  return rows[0];
}
