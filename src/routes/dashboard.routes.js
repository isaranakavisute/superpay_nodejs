import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../dashboard/dashboard.service.js';
import * as repo from '../dashboard/dashboard.repository.js';
import { summaryQuerySchema, trendQuerySchema } from '../dashboard/dashboard.schema.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json(await service.getSummary(summaryQuerySchema.parse(req.query)));
  }),
);

dashboardRouter.get(
  '/trend',
  asyncHandler(async (req, res) => {
    res.json({ data: await service.getTrend(trendQuerySchema.parse(req.query)) });
  }),
);

// "ทุกร้านค้า": in-fee + out-fee of every shop per day (last N days, default 7).
dashboardRouter.get(
  '/fee-trend',
  asyncHandler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number.parseInt(String(req.query.days ?? '7'), 10) || 7));
    res.json({ data: await repo.feeTrend(days) });
  }),
);

dashboardRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    res.json(await service.getAlerts());
  }),
);

export default dashboardRouter;
