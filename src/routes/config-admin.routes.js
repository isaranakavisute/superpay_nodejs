import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import { z } from 'zod';
import * as s from '../config-admin/config.service.js';
import { demoVerify } from '../merchant-api/slip-verify.js';

// Settings page at /api/console/config (behind the console key).
export const configAdminRouter = Router();
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));
const kind = (req) => s.kindParamSchema.parse(req.params).kind;

configAdminRouter.get('/', h(async () => ({ config: await s.getAll() })));
configAdminRouter.get('/public', h(s.getPublic));
configAdminRouter.post('/slip/test', h((req) => s.testProvider(req.actor, s.testBodySchema.parse(req.body))));
const demoSchema = z.object({ image: z.string().min(10).max(11_000_000), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), bankAccountId: z.coerce.number().int().positive().optional() });
configAdminRouter.post('/slip/demo-verify', h(async (req) => ({ result: await demoVerify(demoSchema.parse(req.body)) })));
configAdminRouter.post('/quota/check', h((req) => s.checkQuota(req.actor)));
configAdminRouter.post('/assets/:kind', h((req) => s.uploadAsset(kind(req), req.actor, s.assetBodySchema.parse(req.body))));
configAdminRouter.post('/assets/:kind/:id/delete', h((req) => s.removeAsset(kind(req), req.actor, String(req.params.id).replace(/[^a-f0-9]/g, ''))));
configAdminRouter.post('/assets/:kind/delete', h((req) => s.removeAsset(kind(req), req.actor)));
configAdminRouter.get('/asset/:id', asyncHandler(async (req, res) => {
  const a = await s.getAsset(String(req.params.id).replace(/[^a-f0-9]/g, ''));
  res.set({ 'content-type': a.mime, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' }).send(a.data);
}));
configAdminRouter.post('/:section', h((req) => s.save(s.sectionParamSchema.parse(req.params).section, req.actor, req.body)));

export default configAdminRouter;
