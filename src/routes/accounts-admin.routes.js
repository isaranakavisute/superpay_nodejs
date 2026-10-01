import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../accounts-admin/account.service.js';

// Bank accounts page at /api/console/accounts-admin (behind the console key).
export const accountsAdminRouter = Router();
const id = (req) => s.idParamSchema.parse(req.params).id;
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));

accountsAdminRouter.post('/', h((req) => s.create(req.actor, s.bodySchema.parse(req.body))));
accountsAdminRouter.post('/reset', h((req) => s.reset(s.resetAllSchema.parse(req.body).ids, req.actor)));
accountsAdminRouter.post('/:id/update', h((req) => s.update(id(req), req.actor, s.bodySchema.parse(req.body))));
accountsAdminRouter.post('/:id/toggle', h((req) => s.toggle(id(req), req.actor)));
accountsAdminRouter.post('/:id/reset', h((req) => s.reset([id(req)], req.actor)));
accountsAdminRouter.post('/:id/delete', h((req) => s.remove(id(req), req.actor)));

export default accountsAdminRouter;
