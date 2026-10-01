import { z } from 'zod';

// Half-open window [from, to). Both optional: omitting them means "all time".
export const summaryQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    recent: z.coerce.number().int().min(1).max(50).default(6),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from) < new Date(v.to), {
    message: 'from must be earlier than to',
    path: ['from'],
  });

export const trendQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  merchantId: z.coerce.number().int().positive().optional(),
});
