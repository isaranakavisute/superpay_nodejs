import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../console/console.service.js';
import { listQuerySchema } from '../console/console.schema.js';

export const consoleRouter = Router();

consoleRouter.get('/', (req, res) => {
  res.json({ resources: service.resourceNames() });
});

consoleRouter.get(
  '/:resource',
  asyncHandler(async (req, res) => {
    res.json(await service.listResource(req.params.resource, listQuerySchema.parse(req.query)));
  }),
);

export default consoleRouter;
