import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../dashboard/dashboard.service.js';
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

dashboardRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    res.json(await service.getAlerts());
  }),
);

export default dashboardRouter;
