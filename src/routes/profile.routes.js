import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../profile/profile.service.js';

// Self-service profile at /api/console/profile/:id (behind the console key).
export const profileRouter = Router();
const id = (req) => s.idParamSchema.parse(req.params).id;
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));

profileRouter.get('/:id', h((req) => s.get(id(req))));
profileRouter.post('/:id/info', h((req) => s.updateInfo(id(req), s.infoBodySchema.parse(req.body))));
profileRouter.post('/:id/password', h((req) => s.changePassword(id(req), s.passwordBodySchema.parse(req.body))));
profileRouter.post('/:id/2fa/setup', h((req) => s.setup2fa(id(req))));
profileRouter.post('/:id/2fa/enable', h((req) => s.enable2fa(id(req), s.codeBodySchema.parse(req.body))));
profileRouter.post('/:id/2fa/disable', h((req) => s.disable2fa(id(req), s.disableBodySchema.parse(req.body))));

export default profileRouter;
