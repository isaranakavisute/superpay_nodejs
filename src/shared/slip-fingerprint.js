import { createHash } from 'node:crypto';
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import logger from '../logger.js';

/**
 * What identifies a transfer slip regardless of which order it is attached to:
 * the exact file (sha256) and the QR code Thai bank slips carry (it holds the
 * bank's transaction reference, so a re-screenshot or crop still matches).
 * The QR is best effort: null for WebP or when no QR is found.
 */
export function slipFingerprint(buf, mime) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  let qr = null;
  try {
    const img = mime === 'image/png' ? PNG.sync.read(buf) : mime === 'image/jpeg' ? jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 }) : null;
    if (img) qr = jsQR(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height)?.data?.trim() || null;
  } catch (err) {
    logger.debug({ err: err.message }, 'slip QR not readable');
  }
  return { sha256, qr };
}

/** Option Pay's own sample slip (Merchant Portal → ตัวอย่างสลิป): a guide, never proof of payment. */
export const isSampleSlip = ({ qr }) => typeof qr === 'string' && qr.startsWith('OPTIONPAY-SAMPLE-SLIP');
export const SAMPLE_SLIP_MESSAGE = 'นี่คือสลิปตัวอย่างจาก Option Pay ไม่ใช่หลักฐานการโอน — กรุณาโอนเงินจริงแล้วแนบสลิปจากแอปธนาคาร';

/**
 * The other order this slip is already attached to (oldest first), or null.
 * Slips rejected on their order don't count: the transfer was not applied there.
 * Takes per-fingerprint advisory locks so two uploads of one slip can't race.
 */
export async function findReusedSlip(c, paymentId, { sha256, qr }) {
  for (const key of [sha256, qr].filter(Boolean).sort()) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slip:${key}`]);
  const { rows } = await c.query(
    `SELECT p.ref FROM payment_slips s JOIN payments p ON p.id = s.payment_id
      WHERE s.payment_id <> $1 AND (s.image_sha256 = $2 OR (s.qr_payload IS NOT NULL AND s.qr_payload = $3))
        AND coalesce(s.verify_result->>'decision', '') <> 'invalid'
      ORDER BY s.uploaded_at LIMIT 1`,
    [paymentId, sha256, qr],
  );
  return rows[0]?.ref ?? null;
}
