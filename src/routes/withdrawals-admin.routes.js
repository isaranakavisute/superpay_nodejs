import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../withdrawals/withdrawal.service.js';

// Write actions on withdrawal requests at /api/console/withdrawals (behind the console key).
export const withdrawalsAdminRouter = Router();

const ref = (req) => service.refParamSchema.parse(req.params).ref;

withdrawalsAdminRouter.post('/:ref/approve', asyncHandler(async (req, res) => res.json({ ok: true, ...(await service.approve(ref(req), req.actor)) })));
withdrawalsAdminRouter.post(
  '/:ref/reject',
  asyncHandler(async (req, res) => {
    await service.reject(ref(req), req.actor, service.rejectBodySchema.parse(req.body).reason);
    res.json({ ok: true });
  }),
);

export default withdrawalsAdminRouter;
