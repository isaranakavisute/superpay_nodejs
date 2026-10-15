import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import config from '../config.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { ApiError } from '../merchant-api/v1.service.js';
import * as s from '../merchant-api/v1.service.js';
import { verifyRequestSignature } from '../merchant-api/request-signature.js';
import { z } from 'zod';
import * as subs from '../merchants/sub-merchant.service.js';
import { timingOf } from '../shared/stopwatch.js';

/**
 * Merchant REST API v1 at /api/v1. Authenticated with `X-API-Key` + a request
 * signature (X-Timestamp, X-Signature) except the public checkout routes (token = secret) and
 * /auth/login (secret key in the body). The Next app proxies /api/v1/* here and forwards the public
 * host, so URLs in responses point at the public site.
 */
export const v1Router = Router();

const baseOf = (req) => {
  const host = req.get('x-forwarded-host') ?? req.get('host');
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${host}`;
};
const ipOf = (req) => req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip;
// Slip results carry per-step timings → Server-Timing header (the JSON body is unchanged).
const h = (fn) => asyncHandler(async (req, res) => {
  const out = await fn(req);
  const time = timingOf(out);
  if (time) res.set('Server-Timing', time.header);
  res.json(out);
});

// Login: 10 attempts / minute / IP (in-memory; per process).
const hits = new Map();
function rateLimit(req, _res, next) {
  const ip = ipOf(req);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  if (recent.length > 10) return next(new ApiError(429, 'RATE_LIMITED', 'ลองใหม่อีกครั้งในอีกสักครู่'));
  next();
}

// X-API-Key (ak_live_…) says who is calling; X-Timestamp + X-Signature prove it (request-signature.js).
const requireKey = asyncHandler(async (req, _res, next) => {
  const m = await s.merchantForKey(req.get('x-api-key'));
  if (!m) throw new ApiError(401, 'INVALID_API_KEY', 'X-API-Key ไม่ถูกต้อง ถูกเพิกถอน หรือร้านค้าไม่ได้เปิดใช้งาน (API key ต้องขึ้นต้นด้วย ak_live_)');
  await verifyRequestSignature(req, m);
  // A parent shop's key may act for a shop below it (any depth).
  req.merchant = req.get('x-sub-merchant') ? await s.actAsSubMerchant(m, req.get('x-sub-merchant')) : m;
  next();
});

// ----- public -----
// /auth/login is internal-only (needs the console key, which only the Merchant Portal's server has).
// Shops get their API key in Merchant Portal → ตั้งค่า, issued together with the secret key.
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
function portalOnly(req, _res, next) {
  if (config.consoleApiKey && timingSafeEqual(digest(req.get('x-console-key')), digest(config.consoleApiKey))) return next();
  next(new ApiError(403, 'LOGIN_PORTAL_ONLY', 'เรียก /auth/login จากภายนอกไม่ได้ — รับ API key ได้ที่ Merchant Portal → ตั้งค่า → Secret key และ API key (สร้าง secret key แล้วได้ API key ทันที)'));
}

v1Router.post('/auth/login', portalOnly, rateLimit, h((req) => {
  // Passwords are not accepted on the API; shop users create a secret key in the Merchant Portal.
  if (req.body && typeof req.body === 'object' && 'password' in req.body && !('secretKey' in req.body)) {
    throw new ApiError(400, 'SECRET_KEY_REQUIRED', 'API ไม่รับรหัสผ่านแล้ว — ส่ง {"secretKey": "ms_live_..."} (สร้างได้ที่ Merchant Portal → ตั้งค่า → Secret key)');
  }
  return s.login(s.apiLoginSchema.parse(req.body), ipOf(req));
}));
v1Router.get('/payment/checkout/:token', h((req) => s.checkout(String(req.params.token), { base: baseOf(req) })));
v1Router.post('/payment/checkout/:token/slip', h((req) => s.checkoutSlip(String(req.params.token), s.slipAttachSchema.parse(req.body), { base: baseOf(req) })));


// ----- X-API-Key -----
v1Router.use(requireKey);
const m = (req) => req.merchant;
const opts = (req) => ({ base: baseOf(req) });
// Each endpoint names the permission it needs (Settings → สิทธิ์ผู้ใช้ร้านค้า); keys of a shop user are limited to their level.
const can = (perm) => asyncHandler(async (req, _res, next) => { await s.requirePermission(req.merchant, perm); next(); });

// /collect: same as /payment/create (older name), signed headers like every endpoint.
v1Router.post('/collect', can('create_payment'), h((req) => s.createPayment(m(req), s.createPaymentSchema.parse(req.body), { ...opts(req), source: 'collect' })));
v1Router.post('/payment/create', can('create_payment'), h((req) => s.createPayment(m(req), s.createPaymentSchema.parse(req.body), opts(req))));
v1Router.post('/payment/slip/create', can('create_payment'), h((req) => s.createSlipPayment(m(req), s.slipCreateSchema.parse(req.body), opts(req))));
v1Router.post('/payment/slip/verify', can('create_payment'), h((req) => s.verifyByOrder(m(req), s.slipVerifySchema.parse(req.body), opts(req))));
v1Router.get('/payment/order/:orderId', can('view_transactions'), h((req) => s.byOrder(m(req), String(req.params.orderId), opts(req))));
v1Router.get('/payment/accounts', can('manage_accounts'), h((req) => s.accounts(m(req))));
v1Router.post('/payment/accounts', can('manage_accounts'), h((req) => s.addAccount(m(req), s.accountSchema.parse(req.body))));
v1Router.delete('/payment/accounts/:id', can('manage_accounts'), h((req) => s.removeAccount(m(req), Number(req.params.id) || 0)));
v1Router.post('/payment/:ref/slip', can('create_payment'), h((req) => s.attachByRef(m(req), String(req.params.ref), s.slipAttachSchema.parse(req.body), opts(req))));

v1Router.get('/transactions', can('view_transactions'), h((req) => s.transactions(m(req), s.listQuerySchema.parse(req.query), opts(req))));
v1Router.get('/transactions/:id', can('view_transactions'), h((req) => s.transaction(m(req), String(req.params.id), opts(req))));
v1Router.patch('/transactions/:id/cancel', can('cancel_payment'), h((req) => s.cancel(m(req), String(req.params.id), opts(req))));

v1Router.post('/payout/create', can('create_payout'), h((req) => s.createPayout(m(req), s.payoutSchema.parse(req.body), req.get('idempotency-key')?.slice(0, 100))));
v1Router.post('/payout/bulk', can('create_payout'), h((req) => s.bulkPayout(m(req), s.bulkPayoutSchema.parse(req.body))));
v1Router.get('/payout/ref/:merchantRef', can('view_transactions'), h((req) => s.payout(m(req), { merchantRef: String(req.params.merchantRef) })));
v1Router.get('/payout/:id', can('view_transactions'), h((req) => s.payout(m(req), { id: String(req.params.id) })));
v1Router.get('/payouts', can('view_transactions'), h((req) => s.payouts(m(req), s.listQuerySchema.parse(req.query))));

v1Router.post('/withdrawal/request/create', can('request_withdrawal'), h((req) => s.createWithdrawal(m(req), s.withdrawalSchema.parse(req.body))));
v1Router.get('/withdrawal/requests', can('view_transactions'), h((req) => s.withdrawals(m(req), s.listQuerySchema.parse(req.query))));
v1Router.get('/withdrawal/request/:ref', can('view_transactions'), h((req) => s.withdrawal(m(req), String(req.params.ref))));

v1Router.get('/webhooks', can('manage_webhooks'), h((req) => s.webhooks(m(req))));
v1Router.post('/webhooks', can('manage_webhooks'), h((req) => s.addWebhook(m(req), s.webhookSchema.parse(req.body))));

v1Router.get('/balance', can('view_dashboard'), h((req) => s.balance(m(req))));
v1Router.get('/balance/line-summary', can('view_dashboard'), h((req) => s.lineSummary(m(req))));
v1Router.get('/profile', can('view_dashboard'), h((req) => s.profile(m(req))));
v1Router.get('/dashboard', can('view_dashboard'), h((req) => s.dashboard(m(req))));

// Sub-merchants: shops under this shop (any depth). Reading needs view_dashboard; creating / changing needs manage_sub_merchants.
const subId = (req) => z.coerce.number().int().positive().parse(req.params.id);
const apiActor = (req) => `api:${m(req).slug}${m(req).keyUser ? `/${m(req).keyUser}` : ''}`;
v1Router.get('/sub-merchants', can('view_dashboard'), h((req) => subs.apiList(m(req))));
v1Router.get('/sub-merchants/overview', can('view_dashboard'), h((req) => subs.apiOverview(m(req), subs.networkQuerySchema.parse(req.query))));
v1Router.get('/sub-merchants/:id', can('view_dashboard'), h((req) => subs.apiOne(m(req), subId(req), subs.networkQuerySchema.parse(req.query).days)));
v1Router.post('/sub-merchants', can('manage_sub_merchants'), h(async (req) => ({ success: true, ...(await subs.createSub(m(req).id, apiActor(req), subs.createSubSchema.parse(req.body))), status: 'PENDING' })));
v1Router.post('/sub-merchants/:id', can('manage_sub_merchants'), h((req) => subs.updateSub(m(req).id, subId(req), apiActor(req), subs.updateSubSchema.parse(req.body))));
v1Router.post('/sub-merchants/:id/owner-password', can('manage_sub_merchants'), h((req) => subs.resetOwnerPassword(m(req).id, subId(req), apiActor(req), subs.resetOwnerSchema.parse(req.body))));

export default v1Router;
