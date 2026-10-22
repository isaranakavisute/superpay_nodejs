import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import { ForbiddenError, hasPerm, resolveOperator } from '../middleware/consolePerms.js';
import * as s from '../backups/backup.service.js';
import * as ch from '../backups/change.service.js';

// สำรองข้อมูล: any console user may look; "back up now" and the full restore are Super Admin only (checked here).
export const backupsAdminRouter = Router();
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));
const superAdminOnly = asyncHandler(async (req, _res, next) => {
  const op = await resolveOperator(req.actor, Number(req.get('x-console-user-id')) || null);
  if (!hasPerm(op, '*')) throw new ForbiddenError('สำรอง/กู้คืนข้อมูลได้เฉพาะ Super Admin');
  next();
});

backupsAdminRouter.get('/', h(async (req) => {
  const op = await resolveOperator(req.actor, Number(req.get('x-console-user-id')) || null);
  return { ...(await s.overview()), canManage: hasPerm(op, '*') };
}));
backupsAdminRouter.get('/impact', h((req) => s.impact(s.impactQuerySchema.parse(req.query))));
backupsAdminRouter.post('/run', superAdminOnly, h((req) => s.requestBackup(req.actor)));
backupsAdminRouter.post('/restore', superAdminOnly, h((req) => s.requestRestore(req.actor, s.restoreBodySchema.parse(req.body))));

// Real-time change log: browse (any console user) · preview / undo / replay (Super Admin).
backupsAdminRouter.get('/changes/days', h(() => ch.days()));
backupsAdminRouter.get('/changes', h((req) => ch.transactions(ch.listQuerySchema.parse(req.query))));
backupsAdminRouter.get('/changes/:id', h((req) => ch.change(String(req.params.id).replace(/\D/g, '') || '0')));
backupsAdminRouter.post('/changes/preview', superAdminOnly, h((req) => ch.apply(req.actor, ch.applyBodySchema.parse(req.body), { dry: true })));
backupsAdminRouter.post('/changes/apply', superAdminOnly, h((req) => ch.apply(req.actor, ch.applyBodySchema.parse(req.body), { dry: false })));

export default backupsAdminRouter;
