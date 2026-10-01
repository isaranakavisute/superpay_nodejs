import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../auth/auth.service.js';
import { loginBodySchema } from '../auth/auth.schema.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    // The Next server calls this on the user's behalf and forwards their IP.
    const ip = req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip;
    res.json({ user: await service.login(loginBodySchema.parse(req.body), { ip }) });
  }),
);

export default authRouter;
