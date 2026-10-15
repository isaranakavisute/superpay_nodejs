import { z } from 'zod';

const money = z.coerce.number().positive().max(10_000_000).multipleOf(0.01);
const REF = /^OUT\d{1,12}$/;
export const CATEGORIES = ['refund', 'fee', 'expense', 'transfer', 'other', 'auto', 'commission'];

export const refParamSchema = z.object({ ref: z.string().regex(REF, 'invalid outflow ref') });
// Approval needs no bank account: payouts are paid outside Option Pay and approved after inspection. The account it
// was paid from (send / both) and the bank's transfer reference are optional, for the record.
export const approveBodySchema = z.object({ bankAccountId: z.coerce.number().int().positive().optional(), note: z.string().trim().max(200).optional() });
export const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(300) });
export const updateBodySchema = z.object({
  category: z.enum(CATEGORIES),
  bankAccountId: z.coerce.number().int().positive().nullable(),
  receiverBankCode: z.string().trim().min(2).max(10),
  description: z.string().trim().max(300).optional(),
});
export const bulkBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), refs: z.array(z.string().regex(REF)).min(1).max(200), bankAccountId: z.coerce.number().int().positive().optional(), note: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('reject'), refs: z.array(z.string().regex(REF)).min(1).max(200), reason: z.string().trim().min(1).max(300) }),
]);
export const createBodySchema = z.object({
  category: z.enum(CATEGORIES),
  merchantId: z.coerce.number().int().positive().nullable(),
  bankAccountId: z.coerce.number().int().positive().nullable(),
  receiverName: z.string().trim().min(1).max(120),
  receiverBankCode: z.string().trim().min(2).max(10),
  receiverAccount: z.string().trim().regex(/^[0-9-]{6,20}$/, 'account number: digits and dashes'),
  amount: money,
  description: z.string().trim().max(300).optional(),
});
export const slipBodySchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(16).max(7_000_000).regex(/^[A-Za-z0-9+/=]+$/, 'data must be base64'),
});
