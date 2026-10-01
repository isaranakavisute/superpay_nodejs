import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import asyncHandler from '../middleware/asyncHandler.js';
import * as merchants from '../merchants/merchant.service.js';
import { ApiError } from '../merchant-api/v1.service.js';
import * as v1 from '../merchant-api/v1.service.js';

/**
 * Merchant portal, called by the Next server (console key) on behalf of a
 * signed-in portal user: /api/console/portal/:merchantId/... — the Next
 * server takes merchantId and userId from its own signed portal session.
 */
export const portalRouter = Router();
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));
const ids = z.object({ merchantId: z.coerce.number().int().positive() });

portalRouter.post('/login', h(async (req) => {
  const u = await v1.verifyPortalUser(v1.loginSchema.parse(req.body), req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail, ip) VALUES ($1, 'auth.portal_login', 'merchant', $2, 'เข้าสู่ระบบ Merchant Portal', $3)`, [u.username, u.slug, req.get('x-forwarded-for') ?? null]);
  return { user: { id: u.id, merchantId: u.merchant_id, username: u.username, fullName: u.full_name, tier: u.tier, merchantName: u.merchant_name } };
}));

// Everything below acts as the shop in the URL; owners only for writes (checked by the Next server, re-checked here).
portalRouter.use('/:merchantId', asyncHandler(async (req, _res, next) => {
  const { merchantId } = ids.parse(req.params);
  const { rows } = await query('SELECT * FROM merchants WHERE id = $1', [merchantId]);
  if (!rows[0]) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'ไม่พบร้านค้า');
  const tier = req.get('x-portal-tier');
  if (req.method !== 'GET' && !req.path.endsWith('/password') && tier !== 'owner') throw new ApiError(403, 'OWNER_ONLY', 'เฉพาะเจ้าของร้านเท่านั้น');
  req.shop = rows[0];
  next();
}));
const actor = (req) => `portal:${req.get('x-console-actor') ?? 'unknown'}`;

portalRouter.post('/:merchantId/withdrawals', h(async (req) => v1.createWithdrawal(req.shop, v1.withdrawalSchema.parse(req.body))));
portalRouter.get('/:merchantId/keys', h(async (req) => ({ keys: await merchants.apiKeys(req.shop.id) })));
portalRouter.post('/:merchantId/keys', h((req) => merchants.createKey(req.shop.id, actor(req), merchants.keyBodySchema.parse(req.body))));
portalRouter.post('/:merchantId/keys/:keyId/revoke', h((req) => merchants.revokeKey(req.shop.id, z.coerce.number().int().positive().parse(req.params.keyId), actor(req))));
portalRouter.get('/:merchantId/webhook', h((req) => merchants.webhook(req.shop.id)));
portalRouter.post('/:merchantId/webhook', h((req) => merchants.setWebhook(req.shop.id, actor(req), merchants.webhookBodySchema.parse(req.body))));
portalRouter.post('/:merchantId/webhook/rotate', h((req) => merchants.rotateSecret(req.shop.id, actor(req))));
portalRouter.get('/:merchantId/accounts', h((req) => v1.accounts(req.shop)));
portalRouter.post('/:merchantId/accounts', h((req) => v1.addAccount(req.shop, v1.accountSchema.parse(req.body))));
portalRouter.post('/:merchantId/accounts/:id/delete', h((req) => v1.removeAccount(req.shop, Number(req.params.id) || 0)));
portalRouter.post('/:merchantId/users/:userId/password', h((req) => v1.changePortalPassword(req.shop, Number(req.params.userId) || 0, v1.passwordSchema.parse(req.body))));

export default portalRouter;
