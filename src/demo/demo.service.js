import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { open as unseal, seal } from '../shared/secret-box.js';
import { callbackHeaders, curlOf } from '../webhooks/webhook.service.js';

/**
 * The public demo page (optionpay.co/demo) runs real merchant API calls for one shop only (my-shop).
 * It uses its own shop-level API key, labelled below, created on first use; both the key and its signing
 * secret are stored sealed so the console's server can sign each request. Revoke it in the console to stop the demo.
 */
export const DEMO_SHOP_SLUG = 'my-shop';
const LABEL = 'Demo page (optionpay.co/demo)';
const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function demoKey() {
  const { rows: [shop] } = await query(`SELECT id, name, slug FROM merchants WHERE slug = $1 AND status = 'active'`, [DEMO_SHOP_SLUG]);
  if (!shop) return { shop: null };
  const found = await query(
    `SELECT key_sealed, signing_secret_sealed FROM merchant_api_keys
      WHERE merchant_id = $1 AND label = $2 AND status = 'active' AND key_sealed IS NOT NULL AND signing_secret_sealed IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [shop.id, LABEL]);
  const row = found.rows[0];
  if (!row) {
    const raw = `ak_live_${randomBytes(24).toString('base64url')}`;
    const secret = `ss_live_${randomBytes(32).toString('base64url')}`;
    await query(
      `INSERT INTO merchant_api_keys (merchant_id, label, key_prefix, key_hash, created_by, signing_secret_sealed, key_sealed) VALUES ($1, $2, $3, $4, 'demo-page', $5, $6)`,
      [shop.id, LABEL, `${raw.slice(0, 14)}…`, sha(raw), seal(secret), seal(raw)]);
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('demo-page', 'apikey.create', 'merchant', $1, $2)`, [shop.slug, `ออก API key "${LABEL}" สำหรับหน้า /demo`]);
    return { shop: { name: shop.name, slug: shop.slug }, apiKey: raw, signingSecret: secret };
  }
  return { shop: { name: shop.name, slug: shop.slug }, apiKey: unseal(row.key_sealed), signingSecret: unseal(row.signing_secret_sealed) };
}

const shopId = async () => (await query(`SELECT id FROM merchants WHERE slug = $1`, [DEMO_SHOP_SLUG])).rows[0]?.id ?? null;

/** Remember a ref the demo page created (only the demo shop's own payments / payouts are accepted). */
export async function addRecord({ kind, ref }) {
  const id = await shopId();
  const table = kind === 'payment' ? 'payments' : 'outflows';
  const { rowCount } = await query(`SELECT 1 FROM ${table} WHERE ref = $1 AND merchant_id = $2`, [ref, id]);
  if (rowCount) await query(`INSERT INTO demo_records (kind, ref) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [kind, ref]);
  return { added: rowCount > 0 };
}


/** The demo page's รายการเงินเข้า / รายการเงินออก: only refs it created, with their current state. */
export async function listRecords() {
  const [p, o] = await Promise.all([
    query(
      `SELECT p.ref, p.merchant_order_id AS "orderId", p.amount, p.fee, p.status, p.customer_name AS "customerName", p.description,
              p.slip_received_at AS "slipAt", p.review_note AS "note", p.created_at AS "createdAt", p.completed_at AS "completedAt",
              b.bank_code AS "accountBankCode", b.account_no AS "accountNo", b.account_name AS "accountName", s.provider AS "slipProvider",
              p.deleted_at AS "deletedAt", m.name AS "shopName", m.slug AS "shopSlug", p.delete_reason AS "deleteReason", p.refunded_amount AS "refundedAmount",
              (SELECT coalesce(json_agg(json_build_object('event', w.event, 'statusCode', w.status_code, 'state', w.state, 'attempts', w.attempts,
                 'response', left(w.response_body, 500), 'error', left(w.error, 200), 'at', w.delivered_at) ORDER BY w.id), '[]')
                 FROM webhook_deliveries w WHERE w.payment_ref = d.ref) AS "callbacks"
         FROM demo_records d JOIN payments p ON p.ref = d.ref JOIN merchants m ON m.id = p.merchant_id LEFT JOIN bank_accounts b ON b.id = p.bank_account_id LEFT JOIN payment_slips s ON s.payment_id = p.id
        WHERE d.kind = 'payment' ORDER BY p.created_at DESC LIMIT 100`),
    query(
      `SELECT o.ref, o.merchant_ref AS "merchantRef", o.amount, o.fee, o.status, o.receiver_name AS "receiverName",
              o.receiver_bank_code AS "receiverBankCode", o.receiver_account AS "receiverAccount", o.description,
              o.review_note AS "note", o.created_at AS "createdAt", o.completed_at AS "completedAt", o.source,
              o.admin_done AS "adminDone", o.admin_done_at AS "adminDoneAt", o.deleted_at AS "deletedAt", o.delete_reason AS "deleteReason",
              (SELECT coalesce(json_agg(json_build_object('event', w.event, 'statusCode', w.status_code, 'state', w.state, 'attempts', w.attempts,
                 'response', left(w.response_body, 500), 'error', left(w.error, 200), 'at', w.delivered_at) ORDER BY w.id), '[]')
                 FROM webhook_deliveries w WHERE w.outflow_ref = d.ref) AS "callbacks"
         FROM demo_records d JOIN outflows o ON o.ref = d.ref
        WHERE d.kind = 'payout' ORDER BY o.created_at DESC LIMIT 100`),
  ]);
  return {
    // Names and account numbers in full (requested 19 Oct 2026).
    payments: p.rows,
    payouts: o.rows,
  };
}

/**
 * DEMO slips (made on optionpay.co/demo for one of its own orders): the QR carries
 * "OPTIONPAY-DEMO-SLIP|<ref>|<amount>|<sig>", sig = HMAC-SHA256(demo key's signing secret, "demo-slip.<ref>.<amount>") (first 32 hex).
 * Accepted only for the demo shop's orders created by the demo page, for that exact ref and amount — then the order is
 * approved like a passed slip. Anything else carrying the marker is refused; real slips are checked as usual.
 */
export const DEMO_SLIP_MARKER = 'OPTIONPAY-DEMO-SLIP';
export const isDemoSlip = ({ qr }) => typeof qr === 'string' && qr.startsWith(`${DEMO_SLIP_MARKER}|`);

export async function checkDemoSlip(m, p, qr) {
  const [, ref, amount, sig] = String(qr).split('|');
  if (m.slug !== DEMO_SHOP_SLUG) return 'สลิป DEMO ใช้ได้เฉพาะร้านทดลองบนหน้า optionpay.co/demo — กรุณาแนบสลิปจริงจากแอปธนาคาร';
  const { rowCount } = await query(`SELECT 1 FROM demo_records WHERE kind = 'payment' AND ref = $1`, [p.ref]);
  if (!rowCount) return 'สลิป DEMO ใช้ได้เฉพาะรายการที่สร้างจากหน้า demo';
  if (ref !== p.ref) return `สลิป DEMO นี้เป็นของรายการ ${ref ?? '—'} ไม่ใช่ ${p.ref}`;
  if (Number(amount) !== Number(p.amount)) return `ยอดในสลิป DEMO (${amount}) ไม่ตรงกับยอดของรายการ (${Number(p.amount).toFixed(2)})`;
  const { signingSecret } = await demoKey();
  const expected = createHmac('sha256', signingSecret).update(`demo-slip.${ref}.${amount}`).digest('hex').slice(0, 32);
  if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'สลิป DEMO ไม่ถูกต้อง (ลายเซ็นไม่ตรง) — สร้างสลิป DEMO ใหม่จากหน้า demo';
  return null;
}

/** The slip image of one of the demo page's orders (public on the demo page), or null. */
export async function demoSlip(ref) {
  const { rows } = await query(
    `SELECT s.mime, s.data FROM demo_records d JOIN payments p ON p.ref = d.ref JOIN payment_slips s ON s.payment_id = p.id
      WHERE d.kind = 'payment' AND d.ref = $1`, [ref]);
  return rows[0] ?? null;
}

/**
 * Callback log of the demo page: every POST to the demo shop's webhook for the page's orders (kept in webhook_deliveries,
 * never pruned) — the exact curl, what the webhook answered, and whether the Telegram alert went out.
 */
export async function callbackLog() {
  const { rows } = await query(
    `SELECT w.id, w.event, coalesce(w.payment_ref, w.outflow_ref) AS ref, e.url, w.state, w.status_code AS "statusCode", w.attempts,
            w.response_ms AS "ms", left(w.response_body, 2000) AS response, left(w.error, 300) AS error, w.delivered_at AS "at",
            w.telegram_sent AS "telegramSent", w.telegram_at AS "telegramAt", w.signature, coalesce(w.body, w.payload::text) AS body, (w.body IS NOT NULL) AS exact
       FROM webhook_deliveries w JOIN webhook_endpoints e ON e.id = w.endpoint_id
       JOIN demo_records d ON d.ref = coalesce(w.payment_ref, w.outflow_ref)
      ORDER BY w.id DESC LIMIT 200`);
  return {
    callbacks: rows.map(({ signature, body, ...r }) => ({ ...r, curl: body ? curlOf(r.url, callbackHeaders(r.event, signature), body) : null })),
  };
}

/** The demo shop's fee rates and the fees it has paid so far (approved payments / payouts) — for the demo page's cards. */
export async function shopFees() {
  const { rows: [r] } = await query(
    `SELECT m.id, m.fee_percent AS "feePercent", m.fee_flat AS "feeFlat", m.out_fee_percent AS "outFeePercent", m.out_fee_flat AS "outFeeFlat",
            coalesce((SELECT sum(fee) FROM payments WHERE merchant_id = m.id AND status = 'approved'), 0) AS "paymentFeeTotal",
            (SELECT count(*) FROM payments WHERE merchant_id = m.id AND status = 'approved')::int AS "paymentCount",
            coalesce((SELECT sum(fee) FROM outflows WHERE merchant_id = m.id AND status = 'approved'), 0) AS "payoutFeeTotal",
            (SELECT count(*) FROM outflows WHERE merchant_id = m.id AND status = 'approved')::int AS "payoutCount"
       FROM merchants m WHERE m.slug = $1`, [DEMO_SHOP_SLUG]);
  return { fees: r ?? null };
}
