import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../p2p/p2p.service.js';

// P2P pair actions at /api/console/p2p (behind the console key).
export const p2pAdminRouter = Router();
const ref = (req) => service.refParamSchema.parse(req.params).ref;

p2pAdminRouter.post('/:ref/settle', asyncHandler(async (req, res) => { await service.settle(ref(req), req.actor); res.json({ ok: true }); }));
p2pAdminRouter.post('/:ref/release', asyncHandler(async (req, res) => { await service.release(ref(req), req.actor); res.json({ ok: true }); }));

export default p2pAdminRouter;
