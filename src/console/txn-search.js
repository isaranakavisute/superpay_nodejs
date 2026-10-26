import { z } from 'zod';
import { query } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { visible } from '../shared/private-records.js';

/**
 * Transaction search popup (18 Oct 2026): every transaction search box in the console suggests refs that CONTAIN what
 * was typed (payments TXN…, outflows OUT…, withdrawals WDR…), prefix matches first, with who / which bank / how much;
 * picking one shows everything that happened to it, from creation to now (audit log, slip check, callbacks).
 * Soft-deleted rows are included (marked), and refs deleted for good before soft delete existed are rebuilt from the
 * audit log.
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(40),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const refParamSchema = z.object({ ref: z.string().trim().regex(/^[A-Za-z0-9_-]{2,40}$/) });

const PAYMENT_SELECT = `
  SELECT 'payment' AS kind, p.ref, p.status, p.amount, p.fee, p.currency, p.created_at AS "createdAt", p.completed_at AS "completedAt",
         p.expires_at AS "expiresAt", p.customer_name AS "name", p.merchant_order_id AS "orderId", p.source,
         p.payer_bank_code AS "payerBankCode", pb.name AS "payerBankName", p.payer_account_masked AS "payerAccount",
         p.metadata->>'senderAccountNumber' AS "payerAccountFull",
         a.bank_code AS "accountBankCode", ab.name AS "accountBankName", a.account_name AS "accountName", right(a.account_no, 4) AS "accountLast4",
         m.id AS "merchantId", m.name AS "merchantName", p.review_note AS "note", p.reviewed_by AS "reviewedBy",
         p.slip_received_at AS "slipReceivedAt", p.slip_reused_ref AS "slipReusedRef", p.refunded_amount AS "refundedAmount",
         p.deleted_at AS "deletedAt", p.deleted_by AS "deletedBy", p.delete_reason AS "deleteReason"
    FROM payments p
    LEFT JOIN merchants m ON m.id = p.merchant_id
    LEFT JOIN banks pb ON pb.code = p.payer_bank_code
    LEFT JOIN bank_accounts a ON a.id = p.bank_account_id
    LEFT JOIN banks ab ON ab.code = a.bank_code`;

const OUTFLOW_SELECT = `
  SELECT 'outflow' AS kind, o.ref, o.status, o.amount, o.fee, o.currency, o.created_at AS "createdAt", o.completed_at AS "completedAt",
         NULL::timestamptz AS "expiresAt", o.receiver_name AS "name", o.merchant_ref AS "orderId", o.source,
         o.receiver_bank_code AS "payerBankCode", rb.name AS "payerBankName", o.receiver_account AS "payerAccount", NULL AS "payerAccountFull",
         a.bank_code AS "accountBankCode", ab.name AS "accountBankName", a.account_name AS "accountName", right(a.account_no, 4) AS "accountLast4",
         m.id AS "merchantId", m.name AS "merchantName", o.review_note AS "note", o.admin_done_by AS "reviewedBy",
         NULL::timestamptz AS "slipReceivedAt", NULL AS "slipReusedRef", NULL::numeric AS "refundedAmount",
         o.deleted_at AS "deletedAt", o.deleted_by AS "deletedBy", o.delete_reason AS "deleteReason",
         o.category, o.admin_done AS "adminDone", o.description
    FROM outflows o
    LEFT JOIN merchants m ON m.id = o.merchant_id
    LEFT JOIN banks rb ON rb.code = o.receiver_bank_code
    LEFT JOIN bank_accounts a ON a.id = o.bank_account_id
    LEFT JOIN banks ab ON ab.code = a.bank_code`;

const WITHDRAWAL_SELECT = `
  SELECT 'withdrawal' AS kind, w.ref, w.status, w.amount, w.fee, 'THB' AS currency, w.created_at AS "createdAt", w.decided_at AS "completedAt",
         NULL::timestamptz AS "expiresAt", w.receiver_name AS "name", w.merchant_ref AS "orderId", NULL AS source,
         w.receiver_bank_code AS "payerBankCode", rb.name AS "payerBankName", w.receiver_account AS "payerAccount", NULL AS "payerAccountFull",
         NULL AS "accountBankCode", NULL AS "accountBankName", NULL AS "accountName", NULL AS "accountLast4",
         m.id AS "merchantId", m.name AS "merchantName", coalesce(w.reject_reason, w.note) AS "note", w.approved_by AS "reviewedBy",
         NULL::timestamptz AS "slipReceivedAt", NULL AS "slipReusedRef", NULL::numeric AS "refundedAmount",
         NULL::timestamptz AS "deletedAt", NULL AS "deletedBy", NULL AS "deleteReason",
         (SELECT ref FROM outflows WHERE id = w.outflow_id) AS "outflowRef"
    FROM withdrawal_requests w
    LEFT JOIN merchants m ON m.id = w.merchant_id
    LEFT JOIN banks rb ON rb.code = w.receiver_bank_code`;

const SOURCES = [
  // Deleted records are not searchable (user, 25 Oct 2026): they appear only on รายการที่ลบแล้ว, where they can be restored.
  { kind: 'payment', sql: PAYMENT_SELECT, ref: 'p.ref', extra: ['p.merchant_order_id'], hide: () => `p.deleted_at IS NULL AND ${visible('payment', 'p.ref')}` },
  { kind: 'outflow', sql: OUTFLOW_SELECT, ref: 'o.ref', extra: ['o.merchant_ref'], hide: () => `o.deleted_at IS NULL AND ${visible('outflow', 'o.ref')}` },
  { kind: 'withdrawal', sql: WITHDRAWAL_SELECT, ref: 'w.ref', extra: ['w.merchant_ref'], hide: () => 'true' },
];

/** Refs containing `q` (case-insensitive) across payments, outflows and withdrawals; prefix matches first, newest next. */
export async function search({ q, limit = 20 }) {
  const needle = q.trim();
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const parts = await Promise.all(SOURCES.map(async (s) => {
    const { rows } = await query(
      `${s.sql}
        WHERE (${s.ref} ILIKE $1 OR ${s.extra.map((c) => `${c} ILIKE $1`).join(' OR ')}) AND ${s.hide()}
        ORDER BY (${s.ref} ILIKE $2) DESC, ${s.ref.split('.')[0]}.created_at DESC
        LIMIT $3`,
      [like, `${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit],
    );
    return rows;
  }));
  const found = parts.flat();
  // Refs deleted for good before soft delete (18 Oct 2026): only their audit trail is left.
  const known = new Set(found.map((r) => r.ref));
  const { rows: gone } = await query(
    `SELECT entity_ref AS ref, min(created_at) AS "createdAt", max(created_at) FILTER (WHERE action LIKE '%.delete') AS "deletedAt",
            (array_agg(actor ORDER BY id DESC) FILTER (WHERE action LIKE '%.delete'))[1] AS "deletedBy",
            (array_agg(detail ORDER BY id) FILTER (WHERE action LIKE '%.create'))[1] AS "createDetail"
       FROM audit_logs
      WHERE entity_ref ILIKE $1 AND entity_ref ~ '^(TXN|OUT|WDR)[0-9]+$' AND ${visible(['payment', 'outflow'], 'entity_ref')}
        AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.ref = entity_ref) AND NOT EXISTS (SELECT 1 FROM outflows x WHERE x.ref = entity_ref)
      GROUP BY entity_ref HAVING bool_or(action LIKE '%.delete') ORDER BY max(id) DESC LIMIT $2`,
    [like, limit],
  );
  for (const g of gone) {
    if (known.has(g.ref)) continue;
    found.push({ kind: g.ref.startsWith('OUT') ? 'outflow' : g.ref.startsWith('WDR') ? 'withdrawal' : 'payment', ref: g.ref, status: 'purged', createdAt: g.createdAt,
      deletedAt: g.deletedAt, deletedBy: g.deletedBy, note: g.createDetail, amount: (String(g.createDetail ?? '').match(/ยอด ([\d,]+\.\d\d)/)?.[1] ?? '').replace(/,/g, '') || null });
  }
  const lower = needle.toLowerCase();
  found.sort((a, b) => (Number(b.ref.toLowerCase().startsWith(lower)) - Number(a.ref.toLowerCase().startsWith(lower)))
    || (new Date(b.createdAt) - new Date(a.createdAt)));
  return { data: found.slice(0, limit), total: found.length };
}

const kindOf = (ref) => (/^OUT/i.test(ref) ? 'outflow' : /^WDR/i.test(ref) ? 'withdrawal' : 'payment');

/** One transaction: its details, slip check, webhook deliveries and every audit-log event, oldest first. */
export async function timeline(ref) {
  const kind = kindOf(ref);
  const src = SOURCES.find((s) => s.kind === kind);
  const { rows: hidden } = await query(`SELECT NOT (${visible(['payment', 'outflow'], '$1::text')}) AS h`, [ref]);
  if (hidden[0].h) throw new NotFoundError(`ไม่พบรายการ ${ref}`);
  const { rows } = await query(`${src.sql} WHERE ${src.ref} = $1`, [ref]);
  const details = rows[0] ?? null;
  if (details?.deletedAt) throw new NotFoundError(`ไม่พบรายการ ${ref} (ถูกลบแล้ว — ดูได้ที่หน้ารายการที่ลบแล้ว)`);

  const { rows: events } = await query(
    `SELECT id, created_at AS at, actor, action, entity, detail FROM audit_logs WHERE entity_ref = $1 ORDER BY created_at, id`, [ref]);
  if (!details && !events.length) throw new NotFoundError(`ไม่พบรายการ ${ref}`);

  const col = kind === 'payment' ? 'payment_ref' : kind === 'outflow' ? 'outflow_ref' : 'withdrawal_ref';
  const { rows: deliveries } = await query(
    `SELECT d.id, d.event, d.state, d.status_code AS "statusCode", d.attempts, d.response_ms AS "responseMs", d.error, d.delivered_at AS "deliveredAt",
            e.url
       FROM webhook_deliveries d LEFT JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.${col} = $1 ORDER BY d.id`, [ref]);

  let slip = null;
  if (kind === 'payment' && details) {
    const { rows: s } = await query(
      `SELECT s.uploaded_at AS "uploadedAt", s.uploaded_by AS "uploadedBy", s.provider, coalesce(s.trans_ref, s.verify_result->>'transRef') AS "transRef",
              s.verify_result->>'decision' AS decision, s.verify_result->>'message' AS message, s.verify_result->>'date' AS "transferAt",
              s.verify_result->>'amount' AS amount, s.recheck_at AS "recheckAt", s.recheck_attempts AS "recheckAttempts"
         FROM payment_slips s JOIN payments p ON p.id = s.payment_id WHERE p.ref = $1`, [ref]);
    slip = s[0] ?? null;
  }
  // Without a row (deleted for good before soft delete) the first audit entry stands in for the details.
  const purged = details ? null : { createdAt: events[0]?.at, createDetail: events.find((e) => e.action.endsWith('.create'))?.detail ?? null,
    deletedAt: events.findLast((e) => e.action.endsWith('.delete'))?.at ?? null, deletedBy: events.findLast((e) => e.action.endsWith('.delete'))?.actor ?? null };
  return { ref, kind, details, purged, slip, deliveries, events };
}
