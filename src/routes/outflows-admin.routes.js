import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../outflows/outflow.service.js';
import {
  adminDoneBodySchema,
  approveBodySchema,
  bulkBodySchema,
  createBodySchema,
  refParamSchema,
  rejectBodySchema,
  slipBodySchema,
  updateBodySchema,
} from '../outflows/outflow.schema.js';

// Write actions on outflows at /api/console/outflows (behind the console key).
export const outflowsAdminRouter = Router();

const ref = (req) => refParamSchema.parse(req.params).ref;
const done = (res, extra = {}) => res.json({ ok: true, ...extra });

outflowsAdminRouter.post('/', asyncHandler(async (req, res) => done(res, await service.create(req.actor, createBodySchema.parse(req.body)))));
outflowsAdminRouter.post('/bulk', asyncHandler(async (req, res) => done(res, await service.bulk(req.actor, bulkBodySchema.parse(req.body)))));
outflowsAdminRouter.post('/:ref/admin-done', asyncHandler(async (req, res) => done(res, await service.setAdminDone(ref(req), req.actor, adminDoneBodySchema.parse(req.body ?? {}).done))));
outflowsAdminRouter.post('/:ref/approve', asyncHandler(async (req, res) => done(res, await service.approve(ref(req), req.actor, approveBodySchema.parse(req.body ?? {})))));
outflowsAdminRouter.post('/:ref/reject', asyncHandler(async (req, res) => done(res, await service.reject(ref(req), req.actor, rejectBodySchema.parse(req.body).reason))));
outflowsAdminRouter.post('/:ref/update', asyncHandler(async (req, res) => done(res, await service.update(ref(req), req.actor, updateBodySchema.parse(req.body)))));
outflowsAdminRouter.post('/:ref/slip', asyncHandler(async (req, res) => done(res, await service.uploadSlip(ref(req), req.actor, slipBodySchema.parse(req.body)))));
outflowsAdminRouter.get(
  '/:ref/slip',
  asyncHandler(async (req, res) => {
    const slip = await service.getSlip(ref(req));
    res.set('content-type', slip.mime).set('cache-control', 'private, no-store').send(slip.data);
  }),
);
outflowsAdminRouter.delete('/:ref', asyncHandler(async (req, res) => done(res, await service.remove(ref(req), req.actor))));

export default outflowsAdminRouter;
