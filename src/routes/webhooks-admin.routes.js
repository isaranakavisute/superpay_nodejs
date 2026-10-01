import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../webhooks/webhook.service.js';

// Webhook delivery actions at /api/console/webhooks (behind the console key).
export const webhooksAdminRouter = Router();

webhooksAdminRouter.get('/missing', asyncHandler(async (req, res) => res.json({ data: await s.missing(s.missingQuerySchema.parse(req.query)) })));
webhooksAdminRouter.post('/bulk-retry', asyncHandler(async (req, res) => res.json({ ok: true, ...(await s.bulkRetry(s.bulkBodySchema.parse(req.body).ids, req.actor)) })));
webhooksAdminRouter.post('/:id/retry', asyncHandler(async (req, res) => res.json({ ok: true, ...(await s.retry(s.idParamSchema.parse(req.params).id, req.actor)) })));

export default webhooksAdminRouter;
