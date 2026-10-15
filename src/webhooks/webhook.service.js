import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { open } from '../shared/secret-box.js';
import { BlockedUrlError, safePost } from '../shared/safe-fetch.js';
import { sendAlert } from '../alerts/alert.service.js';
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
async function payloadFor(kind, ref, event) {
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
  const { rows } = await query('SELECT ref, merchant_order_id, amount, status, created_at FROM payments WHERE ref = $1', [ref]);
  const p = rows[0] ?? { ref };
  return { event, ref: p.ref, orderId: p.merchant_order_id, amount: p.amount, status: p.status, createdAt: p.created_at, resentAt: new Date().toISOString() };
}

/**
 * Sends one delivery now: rebuilds the payload, signs it with the endpoint secret
 * (header `X-Signature: t=<unix>,v1=<hex HMAC-SHA256>` over "<t>.<body>"), POSTs through
 * the SSRF-guarded sender and records the outcome — 2xx delivered, otherwise pending until
 * the 5th attempt fails. Telegram is alerted when the endpoint has alerts on for the event.
 */
async function retryOne(id, actor, action = 'webhook.retry') {
  const { rows } = await query(
    `SELECT d.id, d.event, d.attempts, d.payment_ref, d.outflow_ref, d.withdrawal_ref, e.url, e.secret_enc, e.alert_events,
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
  const signature = d.secret_enc ? `t=${t},v1=${createHmac('sha256', open(d.secret_enc)).update(`${t}.${body}`).digest('hex')}` : null;

  let status = null;
  let responseBody = null;
  let ms = null;
  let error = null;
  try {
    const r = await safePost(d.url, { body, headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-webhook-event': d.event, ...(signature ? { 'x-signature': signature } : {}) } });
    ({ status, ms } = r);
    responseBody = r.body;
    if (status < 200 || status >= 300) error = `ปลายทางตอบ ${status}`;
  } catch (err) {
    error = err instanceof BlockedUrlError ? err.message : err?.name === 'TimeoutError' ? 'หมดเวลารอ (timeout 10s)' : `ส่งไม่ถึงปลายทาง: ${err?.cause?.code ?? err?.message}`;
  }
  const ok = status !== null && status >= 200 && status < 300;
  const attempts = d.attempts + 1;
  const state = ok ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

  const result = await withTransaction(async (client) => {
    await client.query(
      `UPDATE webhook_deliveries SET state = $2, attempts = $3, status_code = $4, response_ms = $5, response_body = $6, error = $7,
              payload = $8, signature = $9, delivered_at = now(), next_retry_at = $10 WHERE id = $1`,
      [id, state, attempts, status, ms, responseBody, ok ? null : error, payload, signature, state === 'pending' ? new Date(Date.now() + attempts * 5 * 60_000) : null],
    );
    await client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $4, 'webhook', $2, $3)`, [
      actor ?? 'console', ref, ok ? `ส่งสำเร็จ (${status})` : error, action,
    ]);
    return { state, statusCode: status, error: ok ? null : error };
  });
  if ((d.alert_events ?? []).includes(d.event)) {
    await sendAlert('webhook.delivery', deliveryAlertText({ d, ref, payload, ok, status, ms, error, attempts, state, responseBody }), { merchantId: d.endpoint_merchant_id });
  }
  return result;
}

/** Telegram text for แจ้งเตือน Telegram → "ผลการส่ง webhook ไปยังร้าน": what was sent, and whether it arrived. */
function deliveryAlertText({ d, ref, payload, ok, status, ms, error, attempts, state, responseBody }) {
  const when = (t) => new Date(t).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  const result = ok
    ? `✅ ส่งถึงปลายทางแล้ว — HTTP ${status} (${ms} ms)`
    : `❌ ส่งไม่สำเร็จ — ${error}${state === 'pending' ? ` · จะลองใหม่ครั้งที่ ${attempts + 1} ประมาณ ${when(Date.now() + attempts * 5 * 60_000)}` : ' · ลองครบ 5 ครั้งแล้ว — ส่งใหม่ได้จากหน้า Webhook ร้านค้า'}`;
  return [
    `📤 Callback ${d.event} — ${ref ?? '—'} (ครั้งที่ ${attempts})`,
    result,
    `ปลายทาง: ${d.url}`,
    `ข้อมูลที่ส่ง: ${JSON.stringify(payload)}`,
    status !== null ? `ปลายทางตอบ: ${String(responseBody ?? '').slice(0, 500) || '(ว่าง)'}` : null,
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
       SELECT e.id, e.url, e.merchant_id, ($2 = ANY (e.events)) AS send, up.depth
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
      await sendAlert('webhook.delivery', [
        `📣 ${event} — ${ref}`,
        '⏸ ไม่ได้ส่งไปยังปลายทาง (ปิดการส่ง event นี้ไว้ที่หน้า ตั้งค่าการส่ง Webhook)',
        `ปลายทาง: ${e.url}`,
        `ข้อมูล: ${JSON.stringify(payload)}`,
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
            (e.secret_enc IS NOT NULL) AS signed,
            coalesce((SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY a.id)
                        FROM alert_channels a
                       WHERE a.enabled AND 'webhook.delivery' = ANY (a.events)
                         AND (a.merchant_id IS NULL OR a.merchant_id IN (
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
