import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../users/user.service.js';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userIdParamSchema,
} from '../users/user.schema.js';

export const usersRouter = Router();

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = listUsersQuerySchema.parse(req.query);
    const { items, total } = await service.listUsers(filters);
    res.json({
      data: items,
      pagination: { total, limit: filters.limit, offset: filters.offset },
    });
  }),
);

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createUserSchema.parse(req.body);
    const user = await service.createUser(input);
    res.status(201).location(`/api/users/${user.id}`).json(user);
  }),
);

usersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    res.json(await service.getUser(id));
  }),
);

usersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    const patch = updateUserSchema.parse(req.body);
    res.json(await service.updateUser(id, patch));
  }),
);

export default usersRouter;
