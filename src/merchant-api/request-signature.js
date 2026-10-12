import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { ApiError } from './v1.service.js';

/**
 * Every X-API-Key request carries X-Timestamp (unix seconds) and
 * X-Signature = hex HMAC-SHA256(secret, "<timestamp>.<METHOD>.<path+query>.<raw body>").
 * The secret is never sent: the user's secret key (sk_live_…) for their API key,
 * or the shop key's signing secret (ss_live_…). A signature is accepted once.
 */
export const SIGNATURE_WINDOW_SECONDS = 300;

const fail = (code, message, details) => new ApiError(401, code, message, details);

export async function verifyRequestSignature(req, m) {
  const ts = String(req.get('x-timestamp') ?? '').trim();
  const sig = String(req.get('x-signature') ?? '').trim().toLowerCase();
  if (!ts || !sig) throw fail('SIGNATURE_REQUIRED', 'ต้องส่ง X-Timestamp และ X-Signature ทุกคำขอ — ดูวิธีเซ็นในคู่มือ API');
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d{9,11}$/.test(ts) || Math.abs(now - Number(ts)) > SIGNATURE_WINDOW_SECONDS) {
    throw fail('TIMESTAMP_EXPIRED', `X-Timestamp ต้องเป็นเวลาปัจจุบัน (unix วินาที) คลาดเคลื่อนไม่เกิน ${SIGNATURE_WINDOW_SECONDS / 60} นาที`, { serverTime: now });
  }
  if (!m.signingSecret) throw fail('SIGNING_SECRET_MISSING', 'key นี้ไม่มี secret สำหรับเซ็น — สร้าง secret key ใหม่ (หรือออก API key ใหม่) แล้วเซ็นด้วย secret ที่ได้');
  const prefix = Buffer.from(`${ts}.${req.method}.${req.originalUrl}.`, 'utf8');
  const expected = createHmac('sha256', m.signingSecret).update(Buffer.concat([prefix, req.rawBody ?? Buffer.alloc(0)])).digest('hex');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw fail('INVALID_SIGNATURE', 'X-Signature ไม่ถูกต้อง — เซ็น "timestamp.METHOD.path.body" ด้วย secret ของ key นี้ และส่ง body ให้ตรงกับที่เซ็นทุกตัวอักษร');
  }
  const { rowCount } = await query('INSERT INTO api_request_signatures (signature, merchant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sig, m.id]);
  if (!rowCount) throw fail('SIGNATURE_REUSED', 'ใช้ X-Signature นี้ไปแล้ว — เซ็นใหม่ทุกคำขอ (timestamp ใหม่)');
  if (Math.random() < 0.02) await query(`DELETE FROM api_request_signatures WHERE created_at < now() - interval '10 minutes'`).catch(() => {});
}
