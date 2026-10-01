import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../double-credits/double-credit.service.js';

// Double-credit case actions at /api/console/double-credits (behind the console key).
export const doubleCreditsAdminRouter = Router();
const id = (req) => service.idParamSchema.parse(req.params).id;
const note = (req) => service.noteBodySchema.parse(req.body ?? {}).note;

doubleCreditsAdminRouter.post('/bulk', asyncHandler(async (req, res) => res.json({ ok: true, ...(await service.bulk(req.actor, service.bulkBodySchema.parse(req.body))) })));
doubleCreditsAdminRouter.post('/:id/clawback', asyncHandler(async (req, res) => { await service.clawback(id(req), req.actor, note(req)); res.json({ ok: true }); }));
doubleCreditsAdminRouter.post('/:id/dismiss', asyncHandler(async (req, res) => { await service.dismiss(id(req), req.actor, note(req)); res.json({ ok: true }); }));

export default doubleCreditsAdminRouter;
