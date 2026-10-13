import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import asyncHandler from '../middleware/asyncHandler.js';
import * as merchants from '../merchants/merchant.service.js';
import { ApiError } from '../merchant-api/v1.service.js';
import * as v1 from '../merchant-api/v1.service.js';
import * as subs from '../merchants/sub-merchant.service.js';
import { effectiveStatus, inSubtree } from '../merchants/tree.js';

/**
 * Merchant portal, called by the Next server (console key) on behalf of a
 * signed-in portal user: /api/console/portal/:merchantId/... — the Next
 * server takes merchantId and userId from its own signed portal session.
 */
export const portalRouter = Router();
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));
const ids = z.object({ merchantId: z.coerce.number().int().positive() });
const PORTAL_WRITE_PERMS = [
  [/^\/payments/, 'create_payment'],
  [/^\/withdrawals/, 'request_withdrawal'],
  [/^\/keys/, 'manage_api_keys'],
  [/^\/webhook/, 'manage_webhooks'],
  [/^\/accounts/, 'manage_accounts'],
  [/^\/sub-merchants/, 'manage_sub_merchants'],
];

portalRouter.post('/login', h(async (req) => {
  const u = await v1.verifyPortalUser(v1.loginSchema.parse(req.body), req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail, ip) VALUES ($1, 'auth.portal_login', 'merchant', $2, 'เข้าสู่ระบบ Merchant Portal', $3)`, [u.username, u.slug, req.get('x-forwarded-for') ?? null]);
  return { user: { id: u.id, merchantId: u.merchant_id, username: u.username, fullName: u.full_name, tier: u.tier, merchantName: u.merchant_name, mustChangePassword: u.must_change_password } };
}));

// Everything below acts as the shop in the URL; owners only for writes (checked by the Next server, re-checked here).
portalRouter.use('/:merchantId', asyncHandler(async (req, _res, next) => {
  const { merchantId } = ids.parse(req.params);
  const { rows } = await query('SELECT * FROM merchants WHERE id = $1', [merchantId]);
  if (!rows[0]) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'ไม่พบร้านค้า');
  // The signed-in user's own shop (from the Next server's session): it may read its own shop and every shop
  // below it (view only), and write only to its own shop.
  const home = Number(req.get('x-portal-home') ?? merchantId);
  if (!(await inSubtree({ query }, home, merchantId))) throw new ApiError(403, 'NOT_YOUR_SHOP', 'ไม่มีสิทธิ์เข้าถึงร้านนี้');
  if (req.method !== 'GET' && home !== merchantId) throw new ApiError(403, 'VIEW_ONLY', 'ดูข้อมูลร้านย่อยได้อย่างเดียว — แก้ไขได้ที่หน้า ร้านย่อย ของร้านคุณ');
  // Writes follow the same configurable permission matrix as the API (a user's own password and secret key are always allowed).
  const tier = req.get('x-portal-tier');
  const own = /^\/users\/\d+\/(password|secret-key(\/revoke|\/reveal)?)$/.test(req.path);
  const perm = req.method === 'GET' || own ? null : PORTAL_WRITE_PERMS.find(([re]) => re.test(req.path))?.[1] ?? 'manage_api_keys';
  if (perm && !(await v1.permsForTier(tier)).includes(perm)) throw new ApiError(403, 'PERMISSION_DENIED', `ผู้ใช้ระดับ ${tier} ไม่มีสิทธิ์: ${v1.permissionLabel(perm)}`);
  // A shop waiting for approval (or under a suspended one) can only change its users' own passwords.
  if (perm && (await effectiveStatus({ query }, merchantId)) !== 'active') throw new ApiError(403, 'SHOP_NOT_ACTIVE', 'ร้านนี้ยังรอผู้ดูแลระบบอนุมัติ หรือถูกระงับ — ยังทำรายการนี้ไม่ได้');
  req.shop = rows[0];
  next();
}));
const actor = (req) => `portal:${req.get('x-console-actor') ?? 'unknown'}`;

// Checkout links are built by the Next app (relative here), which knows the public host.
portalRouter.post('/:merchantId/payments', h(async (req) => v1.createPayment(req.shop, v1.createPaymentSchema.parse(req.body), { base: '', source: 'portal', actor: actor(req) })));
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

const userId = (req) => z.coerce.number().int().positive().parse(req.params.userId);
portalRouter.get('/:merchantId/users/:userId/secret-key', h((req) => v1.secretKeyInfo(req.shop, userId(req))));
portalRouter.post('/:merchantId/users/:userId/secret-key', h((req) => v1.createSecretKey(req.shop, userId(req))));
portalRouter.post('/:merchantId/users/:userId/secret-key/reveal', h((req) => v1.revealKeys(req.shop, userId(req), v1.revealSchema.parse(req.body), req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip)));
portalRouter.post('/:merchantId/users/:userId/secret-key/revoke', h((req) => v1.revokeSecretKey(req.shop, userId(req))));

// Sub-merchants (shops under this shop).
const childId = (req) => z.coerce.number().int().positive().parse(req.params.childId);
portalRouter.get('/:merchantId/sub-merchants', h(async (req) => {
  const m = req.shop;
  return {
    subMerchants: await subs.subtree(m),
    // This shop's own rates are the floor for its children; status 'active' only when it and every shop above it are.
    self: { allowSubMerchants: m.allow_sub_merchants, status: await effectiveStatus({ query }, m.id), feePercent: Number(m.fee_percent), feeFlat: Number(m.fee_flat),
      outFeePercent: Number(m.out_fee_percent), outFeeFlat: Number(m.out_fee_flat) },
  };
}));
portalRouter.post('/:merchantId/sub-merchants', h((req) => subs.createSub(req.shop.id, actor(req), subs.createSubSchema.parse(req.body))));
portalRouter.post('/:merchantId/sub-merchants/:childId', h((req) => subs.updateSub(req.shop.id, childId(req), actor(req), subs.updateSubSchema.parse(req.body))));
portalRouter.post('/:merchantId/sub-merchants/:childId/owner-password', h((req) => subs.resetOwnerPassword(req.shop.id, childId(req), actor(req), subs.resetOwnerSchema.parse(req.body))));
// Dashboard of everything below this shop (or one shop below it): ภาพรวมร้านย่อย.
portalRouter.get('/:merchantId/network', h((req) => subs.network(req.shop, subs.networkQuerySchema.parse(req.query))));
// Which shops this user may view: its own and everything below (for the shop switcher).
portalRouter.get('/:merchantId/viewable', h(async (req) => {
  const { rows } = await query(
    `SELECT id, name, cardinality(path) - $2 AS depth, status FROM merchants WHERE id = $1 OR $1 = ANY (path) ORDER BY path || id`,
    [req.shop.id, (req.shop.path ?? []).length],
  );
  return { shops: rows };
}));

export default portalRouter;
