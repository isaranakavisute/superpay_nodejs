import { z } from 'zod';

export const SORTABLE_FIELDS = [
  'created_at',
  'price',
  'rating',
  'sold_count',
  'name',
];

export const listProductsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    location: z.string().trim().min(1).max(100).optional(),
    minPrice: z.coerce.number().int().min(0).optional(),
    maxPrice: z.coerce.number().int().min(0).optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    // Whitelisted so the value can be interpolated into ORDER BY safely.
    sort: z.enum(SORTABLE_FIELDS).default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(
    (v) =>
      v.minPrice === undefined ||
      v.maxPrice === undefined ||
      v.minPrice <= v.maxPrice,
    { message: 'minPrice must not exceed maxPrice', path: ['minPrice'] },
  );

// products.id is bigint, so it is validated as a digit string rather than a
// JS number: int8 exceeds the safe integer range.
export const productIdParamSchema = z.object({
  id: z.string().regex(/^\d{1,19}$/, 'id must be a positive integer'),
});
