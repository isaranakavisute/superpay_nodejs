import { Router } from 'express';
import { healthCheck } from '../db/pool.js';
import asyncHandler from '../middleware/asyncHandler.js';

export const healthRouter = Router();

// Liveness: the process is up. Deliberately does not touch the database.
healthRouter.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: the process can serve traffic, database included.
healthRouter.get(
  '/readyz',
  asyncHandler(async (req, res) => {
    try {
      await healthCheck();
      res.json({ status: 'ok', database: 'up' });
    } catch (err) {
      req.log?.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  }),
);

export default healthRouter;
