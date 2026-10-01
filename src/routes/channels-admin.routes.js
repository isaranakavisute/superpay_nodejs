import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../channels/channel.service.js';

// Channel settings at /api/console/channels (behind the console key).
export const channelsAdminRouter = Router();
const id = (req) => s.idParamSchema.parse(req.params).id;

channelsAdminRouter.post('/', asyncHandler(async (req, res) => res.json({ ok: true, ...(await s.create(req.actor, s.createBodySchema.parse(req.body))) })));
channelsAdminRouter.post('/:id/update', asyncHandler(async (req, res) => { await s.update(id(req), req.actor, s.updateBodySchema.parse(req.body)); res.json({ ok: true }); }));
channelsAdminRouter.delete('/:id', asyncHandler(async (req, res) => res.json({ ok: true, ...(await s.remove(id(req), req.actor)) })));

export default channelsAdminRouter;
