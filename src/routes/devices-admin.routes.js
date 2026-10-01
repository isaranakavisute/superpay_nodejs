import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../devices/device.service.js';

// Forwarder device actions at /api/console/devices (behind the console key).
export const devicesAdminRouter = Router();
const id = (req) => s.idParamSchema.parse(req.params).id;
const h = (fn) => asyncHandler(async (req, res) => { await fn(req); res.json({ ok: true }); });

devicesAdminRouter.post('/:id/rename', h((req) => s.rename(id(req), req.actor, s.renameBodySchema.parse(req.body))));
devicesAdminRouter.post('/:id/suspend', h((req) => s.suspend(id(req), req.actor)));
devicesAdminRouter.post('/:id/resume', h((req) => s.resume(id(req), req.actor)));
devicesAdminRouter.delete('/:id', h((req) => s.remove(id(req), req.actor)));

export default devicesAdminRouter;
