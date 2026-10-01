import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../users-admin/console-user.service.js';

// Console user management at /api/console/users-admin (behind the console key).
export const usersAdminRouter = Router();
const id = (req) => s.idParamSchema.parse(req.params).id;
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));

usersAdminRouter.post('/', h((req) => s.create(req.actor, s.createBodySchema.parse(req.body))));
usersAdminRouter.post('/:id/update', h((req) => s.update(id(req), req.actor, s.updateBodySchema.parse(req.body))));
usersAdminRouter.post('/:id/lock', h((req) => s.lockUser(id(req), req.actor)));
usersAdminRouter.post('/:id/unlock', h((req) => s.unlockUser(id(req), req.actor)));
usersAdminRouter.post('/:id/delete', h((req) => s.deleteUser(id(req), req.actor)));
usersAdminRouter.post('/:id/restore', h((req) => s.restoreUser(id(req), req.actor)));

export default usersAdminRouter;
