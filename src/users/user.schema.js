import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.string().email().max(320).toLowerCase().trim(),
  name: z.string().trim().min(1).max(200),
});

export const updateUserSchema = z
  .object({
    email: z.string().email().max(320).toLowerCase().trim().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => v.email !== undefined || v.name !== undefined, {
    message: 'Provide at least one of email or name',
  });

export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const userIdParamSchema = z.object({ id: z.string().uuid() });
