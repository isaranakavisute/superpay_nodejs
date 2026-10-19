import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { open } from '../shared/secret-box.js';
import { BlockedUrlError, safePost } from '../shared/safe-fetch.js';
import { sendAlert } from '../alerts/alert.service.js';
import logger from '../logger.js';
import { EVENT_CODES, WEBHOOK_EVENTS } from './events.js';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const bulkBodySchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(100) });
export const missingQuerySchema = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

const MAX_ATTEMPTS = 5;
const USER_AGENT = 'OptionPay-Webhook/1.0';
const PAYOUT_STATUS = { pending: 'pending', approved: 'completed', rejected: 'failed' };

/**
 * Payout callback body (payout.completed / payout.failed), always the same keys:
 * {"event","ref","orderId","merchantRef","amount","status","failureReason","createdAt","completedAt"}.
 * orderId = merchantRef (the shop's own reference); amount is a 2-decimal string.
 * completedAt: payout.completed = when the team made the transfer (admin ดำเนินการ → yes); payout.failed = when it was rejected.
 */
export function payoutPayload(event, o) {
  const status = event === 'payout.completed' ? 'completed' : PAYOUT_STATUS[o.status] ?? o.status;
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  return {
    event,
    ref: o.ref,
    orderId: o.merchant_ref ?? null,
    merchantRef: o.merchant_ref ?? null,
    amount: Number(o.amount).toFixed(2),
    status,
    failureReason: status === 'failed' ? o.review_note ?? null : null,
    createdAt: iso(o.created_at),
    completedAt: iso(event === 'payout.completed' ? o.admin_done_at ?? o.completed_at : o.completed_at),
  };
}

/** Shops that had approved orders in the window but no webhook endpoint at all. */
export async function missing({ from = null, to = null }) {
  const { rows } = await query(
    `SELECT m.id, m.name, count(p.id)::int AS orders, min(p.created_at) AS "firstAt", max(p.created_at) AS "lastAt"
       FROM merchants m
       JOIN payments p ON p.merchant_id = m.id AND p.status = 'approved'
                      AND ($1::timestamptz IS NULL OR p.created_at >= $1) AND ($2::timestamptz IS NULL OR p.created_at < $2)
      WHERE NOT EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.merchant_id = m.id)
      GROUP BY m.id ORDER BY orders DESC`,
    [from, to],
  );
  return rows;
}

// Which record a delivery is about: payment (TXN…), payout outflow (OUT…) or withdrawal request (WDR…).
const KINDS = {
  payment: { col: 'payment_ref', owner: 'SELECT merchant_id FROM payments WHERE ref = $1' },
  outflow: { col: 'outflow_ref', owner: 'SELECT merchant_id FROM outflows WHERE ref = $1' },
  withdrawal: { col: 'withdrawal_ref', owner: 'SELECT merchant_id FROM withdrawal_requests WHERE ref = $1' },
};
const kindOf = (d) => (d.withdrawal_ref ? ['withdrawal', d.withdrawal_ref] : d.outflow_ref ? ['outflow', d.outflow_ref] : ['payment', d.payment_ref]);

const WD_STATUS = { pending: 'pending', approved: 'approved', rejected: 'failed' };

/** The body for one event, rebuilt from the record on every attempt (payments keep their original shape). */
export async function payloadFor(kind, ref, event) {
  if (kind === 'outflow') {
    const { rows } = await query('SELECT ref, merchant_ref, amount, status, review_note, created_at, completed_at, admin_done_at FROM outflows WHERE ref = $1', [ref]);
    return rows[0] ? payoutPayload(event, rows[0]) : { event, ref };
  }
  if (kind === 'withdrawal') {
    const { rows } = await query(
      `SELECT w.ref, w.merchant_ref, w.amount, w.status, w.reject_reason, w.created_at, w.decided_at, o.completed_at AS paid_at
         FROM withdrawal_requests w LEFT JOIN outflows o ON o.id = w.outflow_id AND o.status = 'approved' WHERE w.ref = $1`,
      [ref],
    );
    const w = rows[0];
    if (!w) return { event, ref };
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const status = event === 'withdrawal.completed' ? 'completed' : WD_STATUS[w.status] ?? w.status;
    return {
      event, ref: w.ref, orderId: w.merchant_ref ?? null, merchantRef: w.merchant_ref ?? null, amount: Number(w.amount).toFixed(2), status,
      failureReason: status === 'failed' ? w.reject_reason ?? null : null,
      createdAt: iso(w.created_at), completedAt: iso(event === 'withdrawal.completed' ? w.paid_at ?? w.decided_at : w.decided_at),
    };
  }
  // The payment callback body exactly as first sent to prismapays on 15 Oct 2026 (restored 17 Oct at their request):
  // event, ref, orderId, amount, status, createdAt, resentAt (= the time of sending).
  const { rows } = await query('SELECT ref, merchant_order_id, amount, status, created_at FROM payments WHERE ref = $1', [ref]);
  const p = rows[0] ?? { ref };
  return { event, ref: p.ref, orderId: p.merchant_order_id, amount: p.amount, status: p.status, createdAt: p.created_at, resentAt: new Date().toISOString() };
}

const hmacHex = (key, msg) => createHmac('sha256', key).update(msg).digest('hex');

/** Option B key (agreed 18 Oct 2026): the API-request signature formula over this callback, with the shop's sk_live_ key. */
export const deriveCallbackKey = (skLive, t, path, body) => hmacHex(skLive, `${t}.POST.${path}.${body}`);

/** The endpoint shop's owner secret key (sk_live_…), or null. */
async function ownerSecretKey(merchantId) {
  const { rows } = await query(
    `SELECT secret_key_sealed FROM merchant_portal_users WHERE merchant_id = $1 AND tier = 'owner' AND status = 'active'
        AND NOT super_admin AND secret_key_sealed IS NOT NULL ORDER BY id LIMIT 1`,
    [merchantId],
  );
  return rows[0] ? open(rows[0].secret_key_sealed) : null;
}

/** The shop that owns the order behind a callback (payment / payout / withdrawal). */
async function orderMerchantId(kind, ref) {
  if (!kind || !ref) return null;
  const { rows } = await query(KINDS[kind].owner, [ref]);
  return rows[0]?.merchant_id ?? null;
}

/**
 * Rule (19 Oct 2026, for every shop): a callback is signed with the owner secret key of THE SHOP THAT OWNS THE ORDER —
 * a sub-shop's orders with the sub-shop's own key (prismapays verifies that way). If that shop has no active secret key,
 * the nearest shop above it that has one. Returns { sk, shop, prefix, own } (own = the order shop's own key) or null.
 */
async function orderShopKey(orderShopId) {
  const { rows } = await query(
    `WITH RECURSIVE up AS (
        SELECT id, parent_id, 0 AS depth FROM merchants WHERE id = $1
        UNION ALL SELECT m.id, m.parent_id, up.depth + 1 FROM merchants m JOIN up ON m.id = up.parent_id WHERE up.depth < 10)
     SELECT m.id, m.name, up.depth,
            (SELECT u.secret_key_sealed FROM merchant_portal_users u WHERE u.merchant_id = m.id AND u.tier = 'owner' AND u.status = 'active'
                AND NOT u.super_admin AND u.secret_key_sealed IS NOT NULL ORDER BY u.id LIMIT 1) AS sealed,
            (SELECT left(u.secret_key_prefix, 12) FROM merchant_portal_users u WHERE u.merchant_id = m.id AND u.tier = 'owner' AND u.status = 'active'
                AND NOT u.super_admin AND u.secret_key_sealed IS NOT NULL ORDER BY u.id LIMIT 1) AS prefix
       FROM up JOIN merchants m ON m.id = up.id ORDER BY up.depth`,
    [orderShopId],
  );
  const r = rows.find((x) => x.sealed);
  return r ? { sk: open(r.sealed), shop: r.name, prefix: r.prefix, own: r.depth === 0 } : null;
}

const whsecSignature = (e, t, body) => (e.secret_enc ? `t=${t},v1=${hmacHex(open(e.secret_enc), `${t}.${body}`)}` : null);

/**
 * The x-signature of one callback — the single place callbacks are signed (send, retry, resend, alert-only, manuals).
 * e = endpoint { url, secret_enc, signing, merchant_id, order_merchant_id? }. Both key modes use the same 2 steps —
 * key = HMAC(sk_live, t.POST.path.body), v1 = HMAC(key, t.body) — with:
 *   'sk_live_order_shop' (the rule for every shop since 19 Oct 2026): the key of the shop that owns the order
 *      (fallback: the nearest shop above it with a key → `fallback: 'parent'`);
 *   'sk_live_derived' (18 Oct 2026): the key of the webhook's shop.
 * Without any secret key it falls back to the whsec_ secret (`fallback: 'whsec'`).
 */
export async function callbackSignature(e, t, body) {
  const path = new URL(e.url).pathname;
  const sign = (sk) => `t=${t},v1=${hmacHex(deriveCallbackKey(sk, t, path, body), `${t}.${body}`)}`;
  if (e.signing === 'sk_live_order_shop') {
    const k = await orderShopKey(e.order_merchant_id ?? e.merchant_id);
    if (k) return { signature: sign(k.sk), mode: e.signing, keyShop: k.shop, keyPrefix: k.prefix, ...(k.own ? {} : { fallback: 'parent' }) };
  } else if (e.signing === 'sk_live_derived') {
    const sk = await ownerSecretKey(e.merchant_id);
    if (sk) return { signature: sign(sk), mode: e.signing };
  } else {
    return { signature: whsecSignature(e, t, body), mode: 'whsec' };
  }
  logger.warn({ endpointMerchantId: e.merchant_id, orderMerchantId: e.order_merchant_id }, 'callback signing: no secret key — signed with whsec instead');
  return { signature: whsecSignature(e, t, body), mode: 'whsec', fallback: 'whsec' };
}

/**
 * Rule A (18 Oct 2026): before EVERY callback is sent, its x-signature is re-computed INDEPENDENTLY of
 * callbackSignature() — own key lookup, own HMAC steps — from the signing shop's secret key and the exact body, and
 * compared. A signature that does not verify is never sent. Returns { ok, text } — text goes into the Telegram alert.
 */
export async function verifyBeforeSend(e, t, body, signature) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature ?? '');
  if (!m || m[1] !== String(t)) return { ok: false, text: '❌ ไม่ผ่าน — รูปแบบ x-signature ไม่ถูกต้อง · ไม่ได้ส่ง' };
  const same = (hex) => timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(m[2], 'hex'));
  const path = new URL(e.url).pathname;
  if (e.signing === 'sk_live_order_shop') {
    // Independent walk: the order's shop, then up one parent at a time, until a shop with an active owner key.
    let mid = e.order_merchant_id ?? e.merchant_id;
    let row = null;
    for (let i = 0; i < 10 && mid && !row; i += 1) {
      const { rows } = await query(
        `SELECT ms.name, ms.parent_id, u.secret_key_sealed, u.secret_key_prefix FROM merchants ms
           LEFT JOIN merchant_portal_users u ON u.merchant_id = ms.id AND u.tier = 'owner' AND u.status = 'active' AND NOT u.super_admin AND u.secret_key_sealed IS NOT NULL
          WHERE ms.id = $1 ORDER BY u.id LIMIT 1`,
        [mid],
      );
      if (!rows[0]) break;
      if (rows[0].secret_key_sealed) row = { ...rows[0], own: mid === (e.order_merchant_id ?? e.merchant_id) };
      else mid = rows[0].parent_id;
    }
    if (row) {
      const key = createHmac('sha256', open(row.secret_key_sealed)).update(`${t}.POST.${path}.${body}`, 'utf8').digest('hex');
      const ok = same(createHmac('sha256', key).update(`${t}.${body}`, 'utf8').digest('hex'));
      const who = `secret key ของร้าน${row.own ? 'เจ้าของรายการ' : 'แม่ (ร้านเจ้าของรายการไม่มี secret key)'} ${row.name} (${String(row.secret_key_prefix ?? 'sk_live_').slice(0, 12)}…)`;
      return { ok, text: ok
        ? `✅ ผ่าน — คำนวณซ้ำด้วย ${who} + body ที่ส่ง: key = HMAC-SHA256(sk_live, t.POST.${path}.body) → v1 = HMAC-SHA256(key, t.body) ตรงกับ x-signature`
        : `❌ ไม่ผ่าน — คำนวณซ้ำด้วย ${who} + body ที่ส่ง แล้วไม่ตรงกับ x-signature · ไม่ได้ส่ง` };
    }
  }
  if (e.signing === 'sk_live_derived') {
    const { rows } = await query(
      `SELECT ms.name, u.secret_key_sealed, u.secret_key_prefix FROM merchant_portal_users u JOIN merchants ms ON ms.id = u.merchant_id
        WHERE u.merchant_id = $1 AND u.tier = 'owner' AND u.status = 'active' AND NOT u.super_admin AND u.secret_key_sealed IS NOT NULL ORDER BY u.id LIMIT 1`,
      [e.merchant_id],
    );
    if (rows[0]) {
      const key = createHmac('sha256', open(rows[0].secret_key_sealed)).update(`${t}.POST.${path}.${body}`, 'utf8').digest('hex');
      const ok = same(createHmac('sha256', key).update(`${t}.${body}`, 'utf8').digest('hex'));
      const who = `secret key ของร้าน ${rows[0].name} (${String(rows[0].secret_key_prefix ?? 'sk_live_').slice(0, 12)}…)`;
      return { ok, text: ok
        ? `✅ ผ่าน — คำนวณซ้ำด้วย ${who} + body ที่ส่ง: key = HMAC-SHA256(sk_live, t.POST.${path}.body) → v1 = HMAC-SHA256(key, t.body) ตรงกับ x-signature`
        : `❌ ไม่ผ่าน — คำนวณซ้ำด้วย ${who} + body ที่ส่ง แล้วไม่ตรงกับ x-signature · ไม่ได้ส่ง` };
    }
  }
  if (!e.secret_enc) return { ok: false, text: '❌ ไม่ผ่าน — ปลายทางนี้ไม่มี key สำหรับเซ็น · ไม่ได้ส่ง' };
  const ok = same(createHmac('sha256', open(e.secret_enc)).update(`${t}.${body}`, 'utf8').digest('hex'));
  return { ok, text: ok
    ? `✅ ผ่าน — คำนวณซ้ำด้วย webhook secret (whsec_…) ของปลายทาง + body ที่ส่ง ตรงกับ x-signature${e.signing !== 'whsec' ? ' (ร้านไม่มี secret key ที่ใช้งานอยู่ จึงเซ็นด้วย whsec แทน)' : ''}`
    : '❌ ไม่ผ่าน — คำนวณซ้ำด้วย webhook secret + body ที่ส่ง แล้วไม่ตรงกับ x-signature · ไม่ได้ส่ง' };
}

/**
 * Sends one delivery now: rebuilds the payload, signs it with the endpoint secret
 * (header `X-Signature: t=<unix>,v1=<hex HMAC-SHA256>` over "<t>.<body>"), POSTs through
 * the SSRF-guarded sender and records the outcome — 2xx delivered, otherwise pending until
 * the 5th attempt fails. Telegram is alerted when the endpoint has alerts on for the event.
 */
async function retryOne(id, actor, action = 'webhook.retry') {
  const { rows } = await query(
    `SELECT d.id, d.event, d.attempts, d.payment_ref, d.outflow_ref, d.withdrawal_ref, e.url, e.secret_enc, e.alert_events, e.signing,
            e.merchant_id AS endpoint_merchant_id
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.id = $1`,
    [id],
  );
  const d = rows[0];
  if (!d) throw new NotFoundError(`Delivery ${id} does not exist`);
  const [kind, ref] = kindOf(d);

  const payload = await payloadFor(kind, ref, d.event);
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const ep = { url: d.url, secret_enc: d.secret_enc, signing: d.signing, merchant_id: d.endpoint_merchant_id, order_merchant_id: await orderMerchantId(kind, ref) };
  const { signature, fallback, keyShop, keyPrefix } = await callbackSignature(ep, t, body);
  const check = await verifyBeforeSend(ep, t, body, signature);
  if (fallback) {
    const why = fallback === 'parent'
      ? `ร้านเจ้าของรายการไม่มี secret key ที่ใช้งานอยู่ — เซ็นด้วย secret key ของร้านแม่ ${keyShop} (${keyPrefix}…) แทน`
      : 'ร้านเจ้าของรายการและร้านแม่ไม่มี secret key ที่ใช้งานอยู่ — เซ็นด้วย webhook secret แทน';
    await sendAlert('webhook.failed', `⚠️ Callback ${d.event} — ${ref ?? '—'}: ${why}`, { merchantId: d.endpoint_merchant_id }).catch(() => {});
  }

  let status = null;
  let responseBody = null;
  let ms = null;
  let error = null;
  try {
    if (!check.ok) throw Object.assign(new Error('signature self-check failed'), { selfCheck: true });
    const r = await safePost(d.url, { body, headers: callbackHeaders(d.event, signature) });
    ({ status, ms } = r);
    responseBody = r.body;
    if (status < 200 || status >= 300) error = `ปลายทางตอบ ${status}`;
  } catch (err) {
    error = err?.selfCheck ? 'ลายเซ็นไม่ผ่านการตรวจก่อนส่ง — ไม่ได้ส่ง' : err instanceof BlockedUrlError ? err.message : err?.name === 'TimeoutError' ? 'หมดเวลารอ (timeout 10s)' : `ส่งไม่ถึงปลายทาง: ${err?.cause?.code ?? err?.message}`;
  }
  const ok = status !== null && status >= 200 && status < 300;
  const attempts = d.attempts + 1;
  const state = ok ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

  const result = await withTransaction(async (client) => {
    await client.query(
      `UPDATE webhook_deliveries SET state = $2, attempts = $3, status_code = $4, response_ms = $5, response_body = $6, error = $7,
              payload = $8, signature = $9, delivered_at = now(), next_retry_at = $10, body = $11 WHERE id = $1`,
      [id, state, attempts, status, ms, responseBody, ok ? null : error, payload, signature, state === 'pending' ? new Date(Date.now() + attempts * 5 * 60_000) : null, body],
    );
    await client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $4, 'webhook', $2, $3)`, [
      actor ?? 'console', ref, ok ? `ส่งสำเร็จ (${status})` : error, action,
    ]);
    return { state, statusCode: status, error: ok ? null : error };
  });
  if ((d.alert_events ?? []).includes(d.event)) {
    const sent = await sendAlert('webhook.delivery', deliveryAlertText({ d, ref, payload, ok, status, ms, error, attempts, state, responseBody, signature, body, check }), { merchantId: d.endpoint_merchant_id });
    await query('UPDATE webhook_deliveries SET telegram_sent = $2, telegram_at = now() WHERE id = $1', [id, sent]).catch(() => {});
  }
  return result;
}

/** Telegram text for แจ้งเตือน Telegram → "ผลการส่ง webhook ไปยังร้าน": what was sent, and whether it arrived. */
/**
 * The exact headers of a callback POST — one object for the request itself and for the curl shown in Telegram.
 * The format of the first callback to prismapays (15 Oct 2026), restored 17 Oct: content-type, user-agent,
 * x-webhook-event, x-signature — lowercase names.
 */
export function callbackHeaders(event, signature) {
  return { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-webhook-event': event, ...(signature ? { 'x-signature': signature } : {}) };
}

/**
 * The exact request as a curl command (same URL, headers and byte-for-byte body) — shown in every callback alert, in
 * prismapays' format (17 Oct 2026): URL and headers in "double quotes", the body in 'single quotes', POSIX shell.
 */
export function curlOf(url, headers, body) {
  const dq = (x) => `"${String(x).replace(/(["\\$`])/g, '\\$1')}"`;
  const sq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  return [`curl -X POST ${dq(url)}`, ...Object.entries(headers).map(([k, v]) => `  -H ${dq(`${k}: ${v}`)}`), `  --data-raw ${sq(body)}`].join(' \\\n');
}

function deliveryAlertText({ d, ref, payload, ok, status, ms, error, attempts, state, responseBody, signature = null, body = null, check = null }) {
  const when = (t) => new Date(t).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const result = ok
    ? `✅ ส่งถึงปลายทางแล้ว — HTTP ${status} (${ms} ms)`
    : `❌ ส่งไม่สำเร็จ — ${error}${state === 'pending' ? ` · จะลองใหม่ครั้งที่ ${attempts + 1} ประมาณ ${when(Date.now() + attempts * 5 * 60_000)}` : ' · ลองครบ 5 ครั้งแล้ว — ส่งใหม่ได้จากหน้า Webhook ร้านค้า'}`;
  return [
    `📤 Callback ${d.event} — ${ref ?? '—'} (ครั้งที่ ${attempts})`,
    result,
    `ปลายทาง: ${d.url}`,
    `ข้อมูลที่ส่ง: ${JSON.stringify(payload)}`,
    // The headers the receiver verifies with (HMAC-SHA256 of "<t>.<body>" with the endpoint secret) — shown so both sides can compare.
    signature ? `X-Signature: ${signature}` : 'X-Signature: (ไม่มี — ปลายทางนี้ยังไม่มี secret)',
    // Rule B: the result of the independent check made right before sending.
    check ? `🔐 ตรวจลายเซ็นก่อนส่ง: ${check.text}` : null,
    `คำสั่ง curl ที่ส่งจริง:\n${curlOf(d.url, callbackHeaders(d.event, signature), body ?? JSON.stringify(payload))}`,
    // Last, after the request: what the receiver answered (or that it did not answer).
    status !== null ? `ปลายทางตอบ: ${String(responseBody ?? '').slice(0, 500) || '(ว่าง)'}` : `ปลายทางตอบ: (ไม่มีคำตอบ — ${error ?? 'ส่งไม่สำเร็จ'})`,
  ].filter(Boolean).join('\n');
}

export const retry = (id, actor) => retryOne(id, actor);

/** Sequential on purpose: one shop's slow endpoint shouldn't stampede the others. */
export async function bulkRetry(ids, actor) {
  const results = [];
  for (const id of [...new Set(ids)]) results.push({ id, ...(await retryOne(id, actor)) });
  return { results, delivered: results.filter((r) => r.state === 'delivered').length };
}

/**
 * An event happened to a payment / payout / withdrawal: find the nearest shop up the tree (the record's own
 * shop first — a sub-shop acting through its parent's key reaches the parent's endpoint) whose active endpoints
 * post or alert this event, then post it (delivery + retries) and/or alert Telegram. Called after the change
 * has committed. payout.completed is sent once per payout.
 */
async function dispatch(kind, ref, event) {
  const { col, owner } = KINDS[kind];
  const { rows: eps } = await query(
    `WITH RECURSIVE up AS (
       SELECT m.id, m.parent_id, 0 AS depth FROM merchants m WHERE m.id = (${owner})
       UNION ALL
       SELECT m.id, m.parent_id, up.depth + 1 FROM up JOIN merchants m ON m.id = up.parent_id WHERE up.depth < 10
     ), hits AS (
       SELECT e.id, e.url, e.merchant_id, e.secret_enc, e.signing, ($2 = ANY (e.events)) AS send, up.depth
         FROM up JOIN webhook_endpoints e ON e.merchant_id = up.id
        WHERE e.status = 'active' AND ($2 = ANY (e.events) OR $2 = ANY (e.alert_events))
     )
     SELECT * FROM hits WHERE depth = (SELECT min(depth) FROM hits) ORDER BY id`,
    [ref, event],
  );
  let sent = 0;
  for (const e of eps) {
    if (!e.send) {
      // Alert only: posting this event is switched off for the endpoint.
      const payload = await payloadFor(kind, ref, event);
      // Every callback alert carries X-Signature (17 Oct 2026): here the one this body WOULD be sent with.
      const t = Math.floor(Date.now() / 1000);
      const ep = { ...e, order_merchant_id: await orderMerchantId(kind, ref) };
      const { signature: sig } = await callbackSignature(ep, t, JSON.stringify(payload));
      const check = await verifyBeforeSend(ep, t, JSON.stringify(payload), sig);
      await sendAlert('webhook.delivery', [
        `📣 ${event} — ${ref}`,
        '⏸ ไม่ได้ส่งไปยังปลายทาง (ปิดการส่ง event นี้ไว้ที่หน้า ตั้งค่าการส่ง Webhook)',
        `ปลายทาง: ${e.url}`,
        `ข้อมูล: ${JSON.stringify(payload)}`,
        sig ? `X-Signature (ถ้าส่ง): ${sig}` : 'X-Signature: (ไม่มี — ปลายทางนี้ยังไม่มี secret)',
        `🔐 ตรวจลายเซ็น: ${check.text}`,
        `คำสั่ง curl (ถ้าส่ง — ยังไม่ได้ส่ง):\n${curlOf(e.url, callbackHeaders(event, sig), JSON.stringify(payload))}`,
      ].join('\n'), { merchantId: e.merchant_id });
      continue;
    }
    const { rows } = await query(
      `INSERT INTO webhook_deliveries (endpoint_id, event, ${col}, attempts, delivered_at, state)
       SELECT $3, $2, $1, 0, now(), 'pending'
        WHERE $2 <> 'payout.completed' OR NOT EXISTS (
          SELECT 1 FROM webhook_deliveries x WHERE x.outflow_ref = $1 AND x.event = $2 AND x.state IN ('delivered', 'pending'))
       RETURNING id`,
      [ref, event, e.id],
    );
    for (const r of rows) { await retryOne(r.id, 'system', 'webhook.deliver'); sent += 1; }
  }
  return sent;
}

export const deliverPaymentEvent = (paymentRef, event) => dispatch('payment', paymentRef, event);
export const deliverPayoutEvent = (outflowRef, event) => dispatch('outflow', outflowRef, event);
export const deliverWithdrawalEvent = (withdrawalRef, event) => dispatch('withdrawal', withdrawalRef, event);

/** Re-sends pending deliveries when due (attempt n waits n × 5 min; the 5th failure stops). Long-stale ones stay for the webhooks page. */
export async function retryDue(limit = 20) {
  const { rows } = await query(
    `SELECT id FROM webhook_deliveries
      WHERE state = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= now() AND next_retry_at > now() - interval '2 hours'
      ORDER BY next_retry_at LIMIT $1`,
    [limit],
  );
  for (const r of rows) await retryOne(r.id, 'system', 'webhook.retry_auto');
  return rows.length;
}

// ---- ตั้งค่าการส่ง Webhook: per endpoint, per event — post to the shop / alert Telegram ----

export const settingsBodySchema = z.object({
  events: z.array(z.enum(EVENT_CODES)).max(EVENT_CODES.length),
  alertEvents: z.array(z.enum(EVENT_CODES)).max(EVENT_CODES.length),
});

export async function settings() {
  const { rows: endpoints } = await query(
    `SELECT e.id, e.merchant_id AS "merchantId", m.name AS "merchantName", e.url, e.status, e.events, e.alert_events AS "alertEvents",
            (e.secret_enc IS NOT NULL) AS signed, e.signing,
            coalesce((SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY a.id)
                        FROM alert_channels a
                       WHERE a.enabled AND 'webhook.delivery' = ANY (a.events)
                         AND (a.merchant_id IN (
                               WITH RECURSIVE up AS (
                                 SELECT id, parent_id, 0 AS depth FROM merchants WHERE id = e.merchant_id
                                 UNION ALL SELECT x.id, x.parent_id, up.depth + 1 FROM up JOIN merchants x ON x.id = up.parent_id WHERE up.depth < 10)
                               SELECT id FROM up))), '[]') AS "alertBots"
       FROM webhook_endpoints e JOIN merchants m ON m.id = e.merchant_id
      ORDER BY (e.status = 'active') DESC, m.name, e.id`,
  );
  // Every shop is listed: one without its own endpoint follows the nearest parent that has one (or sends nothing).
  const { rows: all } = await query(`SELECT id, name, slug, parent_id AS "parentId", status FROM merchants ORDER BY name, id`);
  const byId = new Map(all.map((m) => [m.id, m]));
  const own = new Map();
  for (const e of endpoints) if (!own.has(e.merchantId)) own.set(e.merchantId, e);
  const via = (m) => {
    for (let p = m.parentId, depth = 0; p != null && depth < 10; depth += 1) {
      const e = own.get(p);
      if (e) return { endpointId: e.id, merchantId: p, merchantName: e.merchantName, url: e.url, status: e.status };
      p = byId.get(p)?.parentId ?? null;
    }
    return null;
  };
  const shops = all.filter((m) => !own.has(m.id)).map((m) => ({
    id: m.id, name: m.name, slug: m.slug, status: m.status, parentName: m.parentId ? byId.get(m.parentId)?.name ?? null : null, via: via(m),
  }));
  return { events: WEBHOOK_EVENTS, endpoints, shops };
}

export function saveSettings(id, actor, { events, alertEvents }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT e.events, e.alert_events, e.url, m.slug FROM webhook_endpoints e JOIN merchants m ON m.id = e.merchant_id WHERE e.id = $1 FOR UPDATE OF e`,
      [id],
    );
    const e = rows[0];
    if (!e) throw new NotFoundError(`Webhook endpoint ${id} does not exist`);
    // Keep the catalogue order; anything unknown that was there before is dropped.
    const ordered = (list) => EVENT_CODES.filter((c) => list.includes(c));
    const send = ordered(events);
    const alert = ordered(alertEvents);
    await client.query('UPDATE webhook_endpoints SET events = $2, alert_events = $3 WHERE id = $1', [id, send, alert]);
    const diff = (before, after) => [
      ...after.filter((x) => !before.includes(x)).map((x) => `+${x}`),
      ...before.filter((x) => !after.includes(x)).map((x) => `-${x}`),
    ].join(' ') || 'ไม่เปลี่ยน';
    await client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'webhook.settings', 'merchant', $2, $3)`, [
      actor ?? 'console', e.slug, `${e.url} · ส่ง: ${diff(e.events, send)} · แจ้ง Telegram: ${diff(e.alert_events ?? [], alert)}`,
    ]);
    return { events: send, alertEvents: alert };
  });
}

let retryTimer = null;
export function startWebhookRetries(logger) {
  if (retryTimer) return;
  let busy = false;
  retryTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await retryDue(); } catch (err) { logger?.warn({ err }, 'webhook auto-retry failed'); } finally { busy = false; }
  }, 60_000);
  retryTimer.unref();
}
export function stopWebhookRetries() {
  clearInterval(retryTimer);
  retryTimer = null;
}

/**
 * Real callbacks of a shop, as the exact curl that was sent — for its own API manual (Merchant Portal, 17 Oct 2026).
 * The endpoint used: the shop's own, else the nearest parent's (as dispatch()). Per posted event, the latest delivery whose
 * signature verifies against the body rebuilt in the code's key order (so the command is byte-exact). Only this shop's tree.
 */
export async function realCallbackExamples(merchantId) {
  const { rows: eps } = await query(
    `WITH RECURSIVE up AS (
       SELECT m.id, m.parent_id, 0 AS depth FROM merchants m WHERE m.id = $1
       UNION ALL SELECT m.id, m.parent_id, up.depth + 1 FROM up JOIN merchants m ON m.id = up.parent_id WHERE up.depth < 10)
     SELECT e.id, e.url, e.secret_enc, e.events, e.signing, e.merchant_id FROM up JOIN webhook_endpoints e ON e.merchant_id = up.id
      WHERE e.status = 'active' AND e.secret_enc IS NOT NULL ORDER BY up.depth, e.id LIMIT 1`,
    [merchantId],
  );
  const e = eps[0];
  if (!e) return { endpointId: null, url: null, signing: null, examples: [] };
  const examples = [];
  for (const event of e.events) {
    const { rows } = await query(
      `SELECT signature, payload, status_code, response_body, delivered_at FROM webhook_deliveries
        WHERE endpoint_id = $1 AND event = $2 AND signature IS NOT NULL AND status_code BETWEEN 200 AND 299 ORDER BY delivered_at DESC LIMIT 20`,
      [e.id, event],
    );
    for (const d of rows) {
      const p = d.payload ?? {};
      const body = JSON.stringify(event.startsWith('payment.')
        ? { event: p.event, ref: p.ref, orderId: p.orderId, amount: p.amount, status: p.status, createdAt: p.createdAt, resentAt: p.resentAt }
        : payoutPayload(event, { ref: p.ref, merchant_ref: p.merchantRef, amount: p.amount, status: { completed: 'approved', failed: 'rejected' }[p.status] ?? p.status,
          review_note: p.failureReason, created_at: p.createdAt, completed_at: p.completedAt, admin_done_at: p.completedAt }));
      const [, t, v1] = String(d.signature).match(/^t=(\d+),v1=([0-9a-f]+)$/) ?? [];
      if (!t || (await callbackSignature(e, t, body)).signature !== `t=${t},v1=${v1}`) continue;
      // The shop's own URL is shown as a placeholder (agreed 17 Oct 2026); headers, signature and body are the real ones.
      const cmd = curlOf(e.url, callbackHeaders(event, d.signature), body).replace(/^curl -X POST "[^"]*" \\/, 'curl -X POST <webhook-url goes here> \\');
      examples.push({ event, sentAt: d.delivered_at, reply: d.response_body, cmd });
      break;
    }
  }
  return { endpointId: e.id, url: e.url, signing: e.signing, path: new URL(e.url).pathname, examples };
}
