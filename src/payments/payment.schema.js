import { z } from 'zod';

const money = z.coerce.number().positive().max(10_000_000).multipleOf(0.01);

export const refParamSchema = z.object({ ref: z.string().regex(/^TXN\d{1,12}$/, 'invalid payment ref') });

export const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(300) });
export const noteBodySchema = z.object({ note: z.string().trim().max(300).optional() });
export const amountBodySchema = z.object({ amount: money });
export const refundBodySchema = z.object({ amount: money.optional(), note: z.string().trim().max(300).optional() });

export const bulkBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), refs: z.array(z.string().regex(/^TXN\d{1,12}$/)).min(1).max(200) }),
  z.object({ action: z.literal('reject'), refs: z.array(z.string().regex(/^TXN\d{1,12}$/)).min(1).max(200), reason: z.string().trim().min(1).max(300) }),
]);

export const assignBodySchema = z.object({
  merchantId: z.coerce.number().int().positive().nullable(),
  merchantOrderId: z.string().trim().max(60).optional(),
});

// Base64 image, ≤ 5 MB decoded.
export const slipBodySchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(16).max(7_000_000).regex(/^[A-Za-z0-9+/=]+$/, 'data must be base64'),
});

export const createBodySchema = z.object({
  merchantId: z.coerce.number().int().positive().nullable(),
  customerName: z.string().trim().min(1).max(120),
  payerBankCode: z.string().trim().min(2).max(10),
  bankAccountId: z.coerce.number().int().positive(),
  amount: money,
  merchantOrderId: z.string().trim().max(60).optional(),
});
