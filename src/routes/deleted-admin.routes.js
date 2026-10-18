import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import { ForbiddenError, hasPerm, resolveOperator } from '../middleware/consolePerms.js';
import { deletedQuerySchema, listDeleted, restoreDeleted, restoreParamSchema } from '../shared/soft-delete.js';

// รายการที่ลบแล้ว: every soft-deleted row (any console user may look); restoring is Super Admin only, checked here.
export const deletedAdminRouter = Router();

const superAdminOnly = asyncHandler(async (req, _res, next) => {
  const op = await resolveOperator(req.actor, Number(req.get('x-console-user-id')) || null);
  if (!hasPerm(op, '*')) throw new ForbiddenError('กู้คืนได้เฉพาะ Super Admin');
  next();
});

deletedAdminRouter.get('/', asyncHandler(async (req, res) => res.json({ ok: true, ...(await listDeleted(deletedQuerySchema.parse(req.query))) })));
deletedAdminRouter.post('/:type/:key/restore', superAdminOnly, asyncHandler(async (req, res) => {
  const { type, key } = restoreParamSchema.parse(req.params);
  res.json({ ok: true, ...(await restoreDeleted(type, key, req.actor)) });
}));

export default deletedAdminRouter;
