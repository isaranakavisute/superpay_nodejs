import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as v1 from '../merchant-api/v1.service.js';
import { verifyRequestSignature } from '../merchant-api/request-signature.js';
import { requestLog } from '../merchant-api/request-log.js';
import { createPaymentV2, createPaymentV2Schema, createPayoutV2, payoutV2, payoutsV2, withReturnUrl } from '../merchant-api/v2.service.js';

/**
 * Merchant REST API v2 at /api/v2 — same authentication as v1 (X-API-Key + X-Timestamp + X-Signature over
 * "timestamp.METHOD./api/v2/…path.body"), same permissions, same request log: POST /payment/create (return_url) and
 * the payout API (status PENDING until transferred, payout.pending callback — v2.service.js).
 */
export const v2Router = Router();
v2Router.use(requestLog);
const baseOf = (req) => `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;
const h = (fn) => asyncHandler(async (req, res) => res.json(await fn(req)));
const requireKey = asyncHandler(async (req, _res, next) => {
  const m = await v1.merchantForKey(req.get('x-api-key'));
  if (!m) throw new v1.ApiError(401, 'INVALID_API_KEY', 'X-API-Key ไม่ถูกต้อง ถูกเพิกถอน หรือร้านค้าไม่ได้เปิดใช้งาน (API key ต้องขึ้นต้นด้วย ak_live_)');
  await verifyRequestSignature(req, m);
  req.merchant = req.get('x-sub-merchant') ? await v1.actAsSubMerchant(m, req.get('x-sub-merchant')) : m;
  next();
});
const can = (perm) => asyncHandler(async (req, _res, next) => { await v1.requirePermission(req.merchant, perm); next(); });

v2Router.post('/payment/create', requireKey, can('create_payment'),
  h((req) => createPaymentV2(req.merchant, createPaymentV2Schema.parse(withReturnUrl(req.body)), { base: baseOf(req) })));

// Payouts, v2 lifecycle (26 Oct 2026) — the v1 /payout/* routes are unchanged.
v2Router.post('/payout/create', requireKey, can('create_payout'),
  h((req) => createPayoutV2(req.merchant, v1.payoutSchema.parse(req.body), req.get('idempotency-key')?.slice(0, 100))));
v2Router.get('/payout/ref/:merchantRef', requireKey, can('view_transactions'), h((req) => payoutV2(req.merchant, { merchantRef: String(req.params.merchantRef) })));
v2Router.get('/payout/:id', requireKey, can('view_transactions'), h((req) => payoutV2(req.merchant, { id: String(req.params.id) })));
v2Router.get('/payouts', requireKey, can('view_transactions'), h((req) => payoutsV2(req.merchant, v1.listQuerySchema.parse(req.query))));

export default v2Router;
