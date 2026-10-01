import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../alerts/alert.service.js';

// Telegram alert bots at /api/console/alert-bots (behind the console key).
export const alertsAdminRouter = Router();

alertsAdminRouter.get('/', asyncHandler(async (req, res) => res.json(await s.load())));
alertsAdminRouter.post('/', asyncHandler(async (req, res) => { await s.save(req.actor, s.saveBodySchema.parse(req.body)); res.json({ ok: true }); }));
alertsAdminRouter.post('/:id/test', asyncHandler(async (req, res) => res.json({ ok: true, ...(await s.test(s.idParamSchema.parse(req.params).id, req.actor)) })));

export default alertsAdminRouter;
