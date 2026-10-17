import { Router } from 'express';
import { z } from 'zod';
import asyncHandler from '../middleware/asyncHandler.js';
import { withTransaction } from '../db/pool.js';
import { BadRequestError } from '../errors.js';
import { extendLeftover } from '../merchant-api/slip-transfers.js';

// Left-overs of bank transfers at /api/console/transfer-leftovers (behind the console key); the list is the
// generic GET /api/console/transfer-leftovers registry resource.
export const transferLeftoversAdminRouter = Router();

const idSchema = z.object({ id: z.coerce.number().int().positive() });
const extendSchema = z.object({ hours: z.coerce.number().int().min(1).max(168) });

transferLeftoversAdminRouter.post('/:id/extend', asyncHandler(async (req, res) => {
  const { id } = idSchema.parse(req.params);
  const { hours } = extendSchema.parse(req.body ?? {});
  const r = await withTransaction((c) => extendLeftover(c, id, req.actor, hours));
  if (!r.ok) throw new BadRequestError(r.error);
  res.json(r);
}));

export default transferLeftoversAdminRouter;
