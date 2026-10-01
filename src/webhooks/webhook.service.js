import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { open } from '../shared/secret-box.js';
import { BlockedUrlError, safePost } from '../shared/safe-fetch.js';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const bulkBodySchema = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(100) });
export const missingQuerySchema = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

const MAX_ATTEMPTS = 5;

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

/**
 * Re-sends one delivery now: rebuilds the payload from the payment, signs it
 * with the endpoint secret (header `X-Signature: t=<unix>,v1=<hex HMAC-SHA256>`
 * over "<t>.<body>"), POSTs through the SSRF-guarded sender and records the
 * outcome — 2xx delivered, otherwise pending until the 5th attempt fails.
 */
async function retryOne(id, actor, action = 'webhook.retry') {
  const { rows } = await query(
    `SELECT d.id, d.event, d.attempts, d.payment_ref, e.url, e.secret_enc, p.ref, p.merchant_order_id, p.amount, p.status, p.created_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id LEFT JOIN payments p ON p.ref = d.payment_ref
      WHERE d.id = $1`,
    [id],
  );
  const d = rows[0];
  if (!d) throw new NotFoundError(`Delivery ${id} does not exist`);

  const payload = { event: d.event, ref: d.ref, orderId: d.merchant_order_id, amount: d.amount, status: d.status, createdAt: d.created_at, resentAt: new Date().toISOString() };
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const signature = d.secret_enc ? `t=${t},v1=${createHmac('sha256', open(d.secret_enc)).update(`${t}.${body}`).digest('hex')}` : null;

  let status = null;
  let responseBody = null;
  let ms = null;
  let error = null;
  try {
    const r = await safePost(d.url, { body, headers: { 'content-type': 'application/json', 'user-agent': 'SuperPay-Webhook/1', ...(signature ? { 'x-signature': signature } : {}) } });
    ({ status, ms } = r);
    responseBody = r.body;
    if (status < 200 || status >= 300) error = `ปลายทางตอบ ${status}`;
  } catch (err) {
    error = err instanceof BlockedUrlError ? err.message : err?.name === 'TimeoutError' ? 'หมดเวลารอ (timeout 10s)' : `ส่งไม่ถึงปลายทาง: ${err?.cause?.code ?? err?.message}`;
  }
  const ok = status !== null && status >= 200 && status < 300;
  const attempts = d.attempts + 1;
  const state = ok ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE webhook_deliveries SET state = $2, attempts = $3, status_code = $4, response_ms = $5, response_body = $6, error = $7,
              payload = $8, signature = $9, delivered_at = now(), next_retry_at = $10 WHERE id = $1`,
      [id, state, attempts, status, ms, responseBody, ok ? null : error, payload, signature, state === 'pending' ? new Date(Date.now() + attempts * 5 * 60_000) : null],
    );
    await client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $4, 'webhook', $2, $3)`, [
      actor ?? 'console', d.payment_ref, ok ? `ส่งสำเร็จ (${status})` : error, action,
    ]);
    return { state, statusCode: status, error: ok ? null : error };
  });
}

export const retry = (id, actor) => retryOne(id, actor);

/** Sequential on purpose: one shop's slow endpoint shouldn't stampede the others. */
export async function bulkRetry(ids, actor) {
  const results = [];
  for (const id of [...new Set(ids)]) results.push({ id, ...(await retryOne(id, actor)) });
  return { results, delivered: results.filter((r) => r.state === 'delivered').length };
}

/**
 * First delivery of a payment event to every active endpoint of the shop that
 * subscribes to it. Called after the payment change has committed; failures
 * stay queued (state pending) for the webhooks page / retry.
 */
export async function deliverPaymentEvent(paymentRef, event) {
  const { rows } = await query(
    `INSERT INTO webhook_deliveries (endpoint_id, event, payment_ref, attempts, delivered_at, state)
     SELECT e.id, $2, p.ref, 0, now(), 'pending'
       FROM payments p JOIN webhook_endpoints e ON e.merchant_id = p.merchant_id
      WHERE p.ref = $1 AND e.status = 'active' AND $2 = ANY (e.events)
     RETURNING id`,
    [paymentRef, event],
  );
  for (const r of rows) await retryOne(r.id, 'system', 'webhook.deliver');
  return rows.length;
}
