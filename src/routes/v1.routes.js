import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import { ApiError } from '../merchant-api/v1.service.js';
import * as s from '../merchant-api/v1.service.js';

/**
 * Merchant REST API v1 at /api/v1. Authenticated with `X-API-Key` except the
 * public checkout routes (token = secret), /collect (key in the body) and
 * /auth/login. The Next app proxies /api/v1/* here and forwards the public
 * host, so URLs in responses point at the public site.
 */
export const v1Router = Router();

const baseOf = (req) => {
  const host = req.get('x-forwarded-host') ?? req.get('host');
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${host}`;
};
const ipOf = (req) => req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip;
const h = (fn) => asyncHandler(async (req, res) => res.json(await fn(req)));

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

const requireKey = asyncHandler(async (req, _res, next) => {
  const m = await s.merchantForKey(req.get('x-api-key'));
  if (!m) throw new ApiError(401, 'INVALID_API_KEY', 'X-API-Key ไม่ถูกต้อง ถูกเพิกถอน หรือร้านค้าไม่ได้เปิดใช้งาน');
  req.merchant = m;
  next();
});

// ----- public -----
v1Router.post('/auth/login', rateLimit, h((req) => s.login(s.loginSchema.parse(req.body), ipOf(req))));
v1Router.get('/payment/checkout/:token', h((req) => s.checkout(String(req.params.token), { base: baseOf(req) })));
v1Router.post('/payment/checkout/:token/slip', h((req) => s.checkoutSlip(String(req.params.token), s.slipAttachSchema.parse(req.body), { base: baseOf(req) })));
v1Router.post('/collect', h(async (req) => {
  const { key, ...body } = s.collectSchema.parse(req.body);
  const m = await s.merchantForKey(key);
  if (!m) throw new ApiError(401, 'INVALID_API_KEY', 'key ไม่ถูกต้อง');
  return s.createPayment(m, body, { base: baseOf(req), source: 'collect' });
}));

// ----- X-API-Key -----
v1Router.use(requireKey);
const m = (req) => req.merchant;
const opts = (req) => ({ base: baseOf(req) });

v1Router.post('/payment/create', h((req) => s.createPayment(m(req), s.createPaymentSchema.parse(req.body), opts(req))));
v1Router.post('/payment/slip/create', h((req) => s.createSlipPayment(m(req), s.slipCreateSchema.parse(req.body), opts(req))));
v1Router.post('/payment/slip/verify', h((req) => s.verifyByOrder(m(req), s.slipVerifySchema.parse(req.body), opts(req))));
v1Router.get('/payment/order/:orderId', h((req) => s.byOrder(m(req), String(req.params.orderId), opts(req))));
v1Router.get('/payment/accounts', h((req) => s.accounts(m(req))));
v1Router.post('/payment/accounts', h((req) => s.addAccount(m(req), s.accountSchema.parse(req.body))));
v1Router.delete('/payment/accounts/:id', h((req) => s.removeAccount(m(req), Number(req.params.id) || 0)));
v1Router.post('/payment/:ref/slip', h((req) => s.attachByRef(m(req), String(req.params.ref), s.slipAttachSchema.parse(req.body), opts(req))));

v1Router.get('/transactions', h((req) => s.transactions(m(req), s.listQuerySchema.parse(req.query), opts(req))));
v1Router.get('/transactions/:id', h((req) => s.transaction(m(req), String(req.params.id), opts(req))));
v1Router.patch('/transactions/:id/cancel', h((req) => s.cancel(m(req), String(req.params.id), opts(req))));

v1Router.post('/payout/create', h((req) => s.createPayout(m(req), s.payoutSchema.parse(req.body), req.get('idempotency-key')?.slice(0, 100))));
v1Router.post('/payout/bulk', h((req) => s.bulkPayout(m(req), s.bulkPayoutSchema.parse(req.body))));
v1Router.get('/payout/ref/:merchantRef', h((req) => s.payout(m(req), { merchantRef: String(req.params.merchantRef) })));
v1Router.get('/payout/:id', h((req) => s.payout(m(req), { id: String(req.params.id) })));
v1Router.get('/payouts', h((req) => s.payouts(m(req), s.listQuerySchema.parse(req.query))));

v1Router.post('/withdrawal/request/create', h((req) => s.createWithdrawal(m(req), s.withdrawalSchema.parse(req.body))));
v1Router.get('/withdrawal/requests', h((req) => s.withdrawals(m(req), s.listQuerySchema.parse(req.query))));
v1Router.get('/withdrawal/request/:ref', h((req) => s.withdrawal(m(req), String(req.params.ref))));

v1Router.get('/webhooks', h((req) => s.webhooks(m(req))));
v1Router.post('/webhooks', h((req) => s.addWebhook(m(req), s.webhookSchema.parse(req.body))));

v1Router.get('/balance', h((req) => s.balance(m(req))));
v1Router.get('/balance/line-summary', h((req) => s.lineSummary(m(req))));
v1Router.get('/profile', h((req) => s.profile(m(req))));
v1Router.get('/dashboard', h((req) => s.dashboard(m(req))));

export default v1Router;
