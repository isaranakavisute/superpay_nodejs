import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../merchants/merchant.service.js';

// Merchant management at /api/console/merchants (behind the console key).
// GET /api/console/merchants itself stays on the generic console list.
export const merchantsAdminRouter = Router();

const id = (req) => s.idParamSchema.parse(req.params).id;
const sub = (req) => s.subIdParamSchema.parse(req.params);
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));

merchantsAdminRouter.post('/', h((req) => s.create(req.actor, s.createBodySchema.parse(req.body))));
merchantsAdminRouter.post('/:id/update', h((req) => s.update(id(req), req.actor, s.updateBodySchema.parse(req.body))));
merchantsAdminRouter.delete('/:id', h((req) => s.remove(id(req), req.actor)));

merchantsAdminRouter.get('/:id/credits', h(async (req) => s.credits(id(req))));
merchantsAdminRouter.post('/:id/credits', h((req) => s.adjustCredit(id(req), req.actor, s.creditBodySchema.parse(req.body))));

merchantsAdminRouter.get('/:id/api-keys', h(async (req) => ({ items: await s.apiKeys(id(req)) })));
merchantsAdminRouter.post('/:id/api-keys', h((req) => s.createKey(id(req), req.actor, s.keyBodySchema.parse(req.body))));
merchantsAdminRouter.post('/:id/api-keys/:subId/revoke', h((req) => s.revokeKey(sub(req).id, sub(req).subId, req.actor)));

merchantsAdminRouter.get('/:id/webhook', h(async (req) => s.webhook(id(req))));
merchantsAdminRouter.post('/:id/webhook', h((req) => s.setWebhook(id(req), req.actor, s.webhookBodySchema.parse(req.body))));
merchantsAdminRouter.post('/:id/webhook/rotate', h((req) => s.rotateSecret(id(req), req.actor)));

merchantsAdminRouter.get('/:id/portal-users', h(async (req) => ({ items: await s.portalUsers(id(req)) })));
merchantsAdminRouter.post('/:id/portal-users', h((req) => s.addPortalUser(id(req), req.actor, s.portalUserBodySchema.parse(req.body))));
merchantsAdminRouter.post('/:id/portal-users/:subId/toggle', h((req) => s.togglePortalUser(sub(req).id, sub(req).subId, req.actor)));

export default merchantsAdminRouter;
