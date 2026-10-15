import { z } from 'zod';

/**
 * A bank account number as people write it ("017-0-80953-6", "017 0 80953 6"): dashes and spaces are dropped,
 * then it must be 6–20 digits. Stored and compared as digits only.
 */
export const accountNumber = (message = 'เลขบัญชีต้องเป็นตัวเลข 6–20 หลัก (ใส่ขีดหรือเว้นวรรคได้)') =>
  z.string().trim().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{6,20}$/, message));
