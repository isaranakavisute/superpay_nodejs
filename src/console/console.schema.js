import { z } from 'zod';

// Filter VALUES are free-form but bounded; they are always bound parameters.
// Which filter NAMES apply is decided by the registry, not by this schema.
export const listQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .catchall(z.string().trim().min(1).max(100));
