import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../events/event.service.js';

// Events inbox actions at /api/console/events (behind the console key).
export const eventsAdminRouter = Router();
const id = (req) => s.idParamSchema.parse(req.params).id;
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));

eventsAdminRouter.post('/simulate', h((req) => s.simulate(req.actor, s.simulateBodySchema.parse(req.body))));
eventsAdminRouter.post('/recheck-today', h((req) => s.recheckToday(req.actor)));
eventsAdminRouter.post('/:id/match', h((req) => s.match(id(req), req.actor, s.matchBodySchema.parse(req.body))));
eventsAdminRouter.post('/:id/create-match', h((req) => s.createAndMatch(id(req), req.actor, s.createMatchBodySchema.parse(req.body))));
eventsAdminRouter.post('/:id/reject', h((req) => s.reject(id(req), req.actor, s.rejectBodySchema.parse(req.body))));
eventsAdminRouter.post('/:id/flip', h((req) => s.flip(id(req), req.actor)));
eventsAdminRouter.post('/:id/recheck', h((req) => s.recheck(id(req), req.actor)));

export default eventsAdminRouter;
