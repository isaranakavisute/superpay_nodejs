import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { open } from '../shared/secret-box.js';

/**
 * Test receiver for shop callbacks (18 Oct 2026): POST /api/v1/payment-external-callback/superpay on OUR backend takes
 * exactly what prismapays' endpoint receives — headers content-type, user-agent, x-webhook-event, x-signature and the
 * one-line JSON body. Its only job: validate x-signature, find the secret key it was made with (tried against the owner
 * keys of the order's shop and every shop above it), and return that key, the original message body, and whether the
 * key is the parent shop my-shop's secret key:
 *   key = HMAC-SHA256(sk_live, t + ".POST." + path + "." + body) (hex),  v1 = HMAC-SHA256(key, t + "." + body)
 * A key is returned only when it made the signature (the caller already holds it) — the URL cannot be used to read one. Only for the parent shop my-shop (and shops under it).
 */
export const CALLBACK_CHECK_PATH = '/api/v1/payment-external-callback/superpay';
export const ALLOWED_PARENT = 'my-shop';
const MAX_AGE_S = 300;

// The body fields prismapays receives, in order (webhook.service.js payloadFor).
export const FIELDS = {
  payment: ['event', 'ref', 'orderId', 'amount', 'status', 'createdAt', 'resentAt'],
  payout: ['event', 'ref', 'orderId', 'merchantRef', 'amount', 'status', 'failureReason', 'createdAt', 'completedAt'],
};
export const EVENTS = { 'payment.approved': 'payment', 'payment.rejected': 'payment', 'payout.completed': 'payout', 'payout.failed': 'payout' };

const hmac = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** The order behind a callback body: payment by ref / orderId, payout by ref / merchantRef. */
async function findOrder(kind, b) {
  if (kind === 'payment') {
    const { rows } = await query(
      `SELECT p.ref, p.merchant_order_id AS "orderId", p.amount, p.status, p.created_at AS "createdAt", p.merchant_id AS "merchantId"
         FROM payments p WHERE p.ref = $1 OR (p.merchant_order_id = $2 AND $2 IS NOT NULL) ORDER BY (p.ref = $1) DESC LIMIT 1`,
      [String(b.ref ?? ''), b.orderId == null ? null : String(b.orderId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await query(
    `SELECT o.ref, o.merchant_ref AS "orderId", o.amount, o.status, o.admin_done AS "adminDone", o.created_at AS "createdAt", o.merchant_id AS "merchantId"
       FROM outflows o WHERE o.ref = $1 OR (o.merchant_ref = $2 AND $2 IS NOT NULL) ORDER BY (o.ref = $1) DESC LIMIT 1`,
    [String(b.ref ?? ''), b.merchantRef ?? b.orderId ?? null],
  );
  return rows[0] ?? null;
}

/** Every shop from the order's own shop up to the top, with its owner's secret key (candidates for the signing key). */
async function keyChain(merchantId) {
  const { rows } = await query(
    `WITH RECURSIVE up AS (
        SELECT id, parent_id, 0 AS depth FROM merchants WHERE id = $1
        UNION ALL SELECT m.id, m.parent_id, up.depth + 1 FROM merchants m JOIN up ON m.id = up.parent_id WHERE up.depth < 10)
     SELECT m.id, m.name, m.slug, up.depth,
            EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.merchant_id = m.id AND e.status = 'active') AS "hasWebhook",
            (SELECT u.secret_key_sealed FROM merchant_portal_users u WHERE u.merchant_id = m.id AND u.tier = 'owner' AND u.status = 'active'
                AND NOT u.super_admin AND u.secret_key_sealed IS NOT NULL ORDER BY u.id LIMIT 1) AS sealed,
            (SELECT left(u.secret_key_prefix, 12) FROM merchant_portal_users u WHERE u.merchant_id = m.id AND u.tier = 'owner' AND u.status = 'active'
                AND NOT u.super_admin AND u.secret_key_sealed IS NOT NULL ORDER BY u.id LIMIT 1) AS prefix
       FROM up JOIN merchants m ON m.id = up.id ORDER BY up.depth`,
    [merchantId],
  );
  return rows.filter((r) => r.sealed);
}

/** Is `merchantId` my-shop or a shop under it? */
async function underAllowedParent(merchantId) {
  const { rows } = await query(
    `SELECT EXISTS (SELECT 1 FROM merchants m, merchants p WHERE p.slug = $2 AND m.id = $1 AND (m.id = p.id OR p.id = ANY (m.path))) AS ok`,
    [merchantId, ALLOWED_PARENT],
  );
  return rows[0].ok;
}

/**
 * Checks one callback request. `raw` = the body bytes exactly as received. Returns { status, body } — 200 when the
 * signature matches, 401 when it does not, 400 / 403 / 404 for a malformed request or an order outside my-shop.
 */
export async function checkCallback({ headers, raw, path = CALLBACK_CHECK_PATH, now = Date.now() }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const out = { valid: false, receivedAt: new Date(now).toISOString(), path };
  const fail = (status, code, message, extra = {}) => ({ status, body: { ...out, error: { code, message }, ...extra } });

  // 1. the request as prismapays receives it
  const request = {
    contentType: h['content-type'] ?? null, userAgent: h['user-agent'] ?? null,
    event: h['x-webhook-event'] ?? null, signature: h['x-signature'] ?? null,
  };
  out.request = request;
  if (!raw?.length) return fail(400, 'EMPTY_BODY', 'ไม่มี body (ต้องเป็น JSON บรรทัดเดียว content-type: application/json)');
  const body = raw.toString('utf8');
  let b;
  try { b = JSON.parse(body); } catch { return fail(400, 'BAD_JSON', 'body ไม่ใช่ JSON'); }
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(request.signature ?? '');
  if (!m) return fail(400, 'BAD_SIGNATURE_HEADER', 'x-signature ต้องเป็นรูปแบบ t=<unix วินาที>,v1=<hex 64 ตัว>');
  const [, t, v1] = m;
  const kind = EVENTS[b.event];
  if (!kind) return fail(400, 'UNKNOWN_EVENT', `event ต้องเป็น ${Object.keys(EVENTS).join(' / ')}`);

  const fields = FIELDS[kind];
  const keys = Object.keys(b);
  out.event = b.event;
  out.checks = {
    contentType: /^application\/json/i.test(request.contentType ?? ''),
    userAgent: request.userAgent === 'OptionPay-Webhook/1.0',
    eventHeaderMatchesBody: request.event === b.event,
    fieldsInOrder: keys.length === fields.length && keys.every((k, i) => k === fields[i]),
    missingFields: fields.filter((f) => !keys.includes(f)),
    extraFields: keys.filter((k) => !fields.includes(k)),
    timestampAgeSeconds: Math.round(now / 1000 - Number(t)),
  };
  out.checks.timestampFresh = Math.abs(out.checks.timestampAgeSeconds) <= MAX_AGE_S;

  // 2. the order and its shop (my-shop's tree only)
  const order = await findOrder(kind, b);
  if (!order) return fail(404, 'ORDER_NOT_FOUND', `ไม่พบรายการ ${b.ref ?? b.orderId ?? ''}`);
  if (!(await underAllowedParent(order.merchantId))) return fail(403, 'NOT_ALLOWED', `ใช้ได้เฉพาะรายการของร้าน ${ALLOWED_PARENT} และร้านย่อย`);
  const chain = await keyChain(order.merchantId);
  if (!chain.length) return fail(409, 'NO_SECRET_KEY', 'ร้านเจ้าของรายการและร้านแม่ยังไม่มี secret key ที่ใช้งานอยู่');
  const parent = chain.find((r) => r.slug === ALLOWED_PARENT);
  out.order = { kind, ref: order.ref, orderId: order.orderId, amount: Number(order.amount).toFixed(2), status: order.status, createdAt: iso(order.createdAt) };
  out.checks.matchesOrder = {
    ref: b.ref === order.ref,
    amount: String(b.amount) === Number(order.amount).toFixed(2),
    createdAt: b.createdAt === iso(order.createdAt),
  };

  // 3. which secret key made this signature? key = HMAC(sk_live, t.POST.path.body), v1 = HMAC(key, t.body) — tried with
  //    each candidate key against the body exactly as received.
  const v1Of = (sk) => hmac(hmac(sk, `${t}.POST.${path}.${body}`), `${t}.${body}`);
  let found = null;
  for (const r of chain) { const sk = open(r.sealed); if (same(v1Of(sk), v1)) { found = { ...r, sk }; break; } }
  const parentSk = parent ? open(parent.sealed) : null;
  out.valid = !!found;
  out.signature = { t: Number(t), received: v1, ...(found ? {} : { expectedWithParentKey: parentSk ? v1Of(parentSk) : null }),
    formula: `key = HMAC-SHA256(sk_live, t.POST.${path}.body) → v1 = HMAC-SHA256(key, t.body)` };
  // extracted = recovered from the incoming request (the key that reproduces its x-signature from its body);
  // retrieved = my-shop's secret key read from the database — in full only when the signature is valid.
  out.extractedSecretKey = found ? found.sk : null;
  out.extractedSecretKeyOwner = found ? found.slug : null;
  out.retrievedSecretKey = parentSk ? (found ? parentSk : `${parent.prefix}… (แสดงเต็มเฉพาะเมื่อลายเซ็นถูกต้อง)`) : null;
  out.retrievedSecretKeyOwner = parent ? parent.slug : null;
  out.secretKeyMatchesParent = !!(found && parentSk && same(found.sk, parentSk));
  out.messageBody = body;
  out.messageBodyJson = b;
  out.message = found
    ? `✅ ลายเซ็นถูกต้อง — เซ็นด้วย secret key ของร้าน ${found.slug} (${found.prefix}…) + body ที่ได้รับ · ${out.secretKeyMatchesParent ? `ตรงกับ secret key ของร้านแม่ ${ALLOWED_PARENT}` : `ไม่ใช่ key ของร้านแม่ ${ALLOWED_PARENT}`}`
    : `❌ ลายเซ็นไม่ตรงกับ secret key ใดของร้านเจ้าของรายการหรือร้านแม่ ${ALLOWED_PARENT} — body ถูกแก้ หรือเซ็นด้วย key อื่น`;
  const shop = found ?? parent ?? chain[0];

  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('callback-check', 'webhook.verify', 'webhook', $1, $2)`,
    [order.ref, `${b.event} ถึงปลายทางทดสอบ ${path}: ${out.valid ? 'ลายเซ็นถูกต้อง' : 'ลายเซ็นไม่ตรง'} (เซ็นด้วย ${shop.prefix}… ของ ${shop.slug})`]).catch(() => {});
  const { valid, message, extractedSecretKey, extractedSecretKeyOwner, retrievedSecretKey, retrievedSecretKeyOwner, secretKeyMatchesParent, messageBody, messageBodyJson, ...rest } = out;
  return { status: valid ? 200 : 401, body: { valid, message, extractedSecretKey, extractedSecretKeyOwner, retrievedSecretKey, retrievedSecretKeyOwner, secretKeyMatchesParent, messageBody, messageBodyJson, ...rest } };
}
