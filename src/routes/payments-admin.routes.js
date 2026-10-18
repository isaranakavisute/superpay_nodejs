import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import { reasonOf } from '../shared/soft-delete.js';
import * as service from '../payments/payment.service.js';
import {
  amountBodySchema,
  assignBodySchema,
  slipBodySchema,
  bulkBodySchema,
  createBodySchema,
  noteBodySchema,
  refParamSchema,
  refundBodySchema,
  rejectBodySchema,
} from '../payments/payment.schema.js';

// Write actions on payments, mounted at /api/console/payments behind the console key.
// Reads stay on the generic GET /api/console/payments list.
export const paymentsAdminRouter = Router();

const ref = (req) => refParamSchema.parse(req.params).ref;
const done = (res, extra = {}) => res.json({ ok: true, ...extra });

paymentsAdminRouter.post('/', asyncHandler(async (req, res) => done(res, await service.create(req.actor, createBodySchema.parse(req.body)))));
paymentsAdminRouter.post('/bulk', asyncHandler(async (req, res) => done(res, await service.bulk(req.actor, bulkBodySchema.parse(req.body)))));
paymentsAdminRouter.post('/:ref/approve', asyncHandler(async (req, res) => done(res, await service.approve(ref(req), req.actor, noteBodySchema.parse(req.body ?? {}).note))));
paymentsAdminRouter.post('/:ref/reject', asyncHandler(async (req, res) => done(res, await service.reject(ref(req), req.actor, rejectBodySchema.parse(req.body).reason))));
paymentsAdminRouter.post('/:ref/refund', asyncHandler(async (req, res) => done(res, await service.refund(ref(req), req.actor, refundBodySchema.parse(req.body ?? {})))));
paymentsAdminRouter.post('/:ref/amount', asyncHandler(async (req, res) => done(res, await service.editAmount(ref(req), req.actor, amountBodySchema.parse(req.body).amount))));
paymentsAdminRouter.post('/:ref/revive', asyncHandler(async (req, res) => done(res, await service.revive(ref(req), req.actor))));
paymentsAdminRouter.post('/:ref/assign', asyncHandler(async (req, res) => done(res, await service.assignMerchant(ref(req), req.actor, assignBodySchema.parse(req.body)))));
paymentsAdminRouter.post('/:ref/slip', asyncHandler(async (req, res) => done(res, await service.uploadSlip(ref(req), req.actor, slipBodySchema.parse(req.body)))));
paymentsAdminRouter.get(
  '/:ref/slip',
  asyncHandler(async (req, res) => {
    const slip = await service.getSlip(ref(req));
    res.set('content-type', slip.mime).set('cache-control', 'private, no-store').send(slip.data);
  }),
);
paymentsAdminRouter.delete('/:ref', asyncHandler(async (req, res) => done(res, await service.remove(ref(req), req.actor, reasonOf(req.body)))));

export default paymentsAdminRouter;
