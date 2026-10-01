import { z } from 'zod';

export const loginBodySchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(100),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(10).optional(),
});
