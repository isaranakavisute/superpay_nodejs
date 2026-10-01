import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as s from '../roles/role.service.js';

// Role permissions at /api/console/roles-admin (behind the console key).
export const rolesAdminRouter = Router();
rolesAdminRouter.get('/catalogue', (req, res) => res.json({ groups: s.PERMISSIONS.map(([name, perms]) => ({ name, perms })) }));
rolesAdminRouter.post('/', asyncHandler(async (req, res) => res.json({ ok: true, ...(await s.save(req.actor, s.saveBodySchema.parse(req.body))) })));
export default rolesAdminRouter;
