#!/usr/bin/env node
// Sends one shop callback exactly as Option Pay sends it to prismapays — same body (payloadFor), same 4 headers, same
// signature (callbackSignature: the shop's sk_live_ key + the body) — to a callback-check endpoint, and prints the reply.
//   node scripts/send-test-callback.mjs TXN174623 payment.approved            → http://localhost:3001 (local backend)
//   node scripts/send-test-callback.mjs OUT40609 payout.completed https://optionpay.co
// Only my-shop's test webhook (#9) is used for signing; nothing is changed in the database except the endpoint's audit line.
import { callbackSignature, payloadFor } from '../src/webhooks/webhook.service.js';
import { query } from '../src/db/pool.js';

const [ref, event, base = 'http://localhost:3001'] = process.argv.slice(2);
const EVENTS = ['payment.approved', 'payment.rejected', 'payout.completed', 'payout.failed'];
if (!ref || !EVENTS.includes(event)) {
  console.error(`usage: node scripts/send-test-callback.mjs <TXN…|OUT…> <${EVENTS.join('|')}> [base-url]`);
  process.exit(1);
}
const { rows } = await query(
  `SELECT e.url, e.secret_enc, e.signing, e.merchant_id FROM webhook_endpoints e JOIN merchants m ON m.id = e.merchant_id
    WHERE m.slug = 'my-shop' AND e.status = 'active' ORDER BY e.id LIMIT 1`);
if (!rows[0]) { console.error("my-shop has no active webhook"); process.exit(1); }
const e = rows[0];
const path = new URL(e.url).pathname;
const kind = event.startsWith('payout.') ? 'payout' : 'payment';
const body = JSON.stringify(await payloadFor(kind, ref, event));
const t = Math.floor(Date.now() / 1000);
const { signature } = await callbackSignature(e, t, body);
const headers = { 'content-type': 'application/json', 'user-agent': 'OptionPay-Webhook/1.0', 'x-webhook-event': event, 'x-signature': signature };

console.log(`POST ${base}${path}\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}\n`);
const r = await fetch(`${base}${path}`, { method: 'POST', headers, body });
console.log(`→ HTTP ${r.status}\n${JSON.stringify(await r.json(), null, 2)}`);
process.exit(0);
