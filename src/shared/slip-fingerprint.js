import { createHash } from 'node:crypto';
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import logger from '../logger.js';

/**
 * Does the image contain QR finder patterns (the three corner squares, dark:light:dark:light:dark
 * = 1:1:3:1:1 across and down) even though it did not decode? Lets us tell "something that looks
 * like a QR but is not a real one" (typical of an edited / generated fake slip) from "no QR at all".
 */
export function hasQrFinderPatterns(img) {
  const { width: w, height: h, data } = img;
  if (!w || !h) return false;
  const lum = (x, y) => { const i = (y * w + x) * 4; return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000; };
  let sum = 0, n = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { sum += lum(x, y); n++; }
  const threshold = Math.min(sum / n, 160);
  const dark = (x, y) => lum(x, y) < threshold;
  const fits = (runs) => {
    const total = runs.reduce((a, r) => a + r, 0);
    if (total < 7) return false;
    const m = total / 7, tol = m * 0.6;
    return Math.abs(runs[0] - m) < tol && Math.abs(runs[1] - m) < tol && Math.abs(runs[2] - 3 * m) < 3 * tol && Math.abs(runs[3] - m) < tol && Math.abs(runs[4] - m) < tol;
  };
  // Column runs through (cx, cy): the same 1:1:3:1:1 must hold vertically.
  const verticalFits = (cx, cy, size) => {
    if (!dark(cx, cy)) return false;
    const runs = [0, 0, 0, 0, 0];
    let y = cy;
    while (y >= 0 && dark(cx, y)) { runs[2]++; y--; }
    for (const [k, want] of [[1, false], [0, true]]) while (y >= 0 && dark(cx, y) === want && runs[k] <= size) { runs[k]++; y--; }
    y = cy + 1;
    while (y < h && dark(cx, y)) { runs[2]++; y++; }
    for (const [k, want] of [[3, false], [4, true]]) while (y < h && dark(cx, y) === want && runs[k] <= size) { runs[k]++; y++; }
    return fits(runs);
  };
  const centers = [];
  for (let y = 0; y < h; y += 2) {
    const runs = [];
    let cur = dark(0, y), len = 0, startX = 0;
    const starts = [];
    for (let x = 0; x <= w; x++) {
      const d = x < w ? dark(x, y) : !cur;
      if (d === cur) { len++; continue; }
      runs.push({ dark: cur, len }); starts.push(startX);
      cur = d; len = 1; startX = x;
    }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (!runs[i].dark) continue;
      const five = runs.slice(i, i + 5).map((r) => r.len);
      if (!fits(five)) continue;
      const size = five.reduce((a, r) => a + r, 0);
      const cx = Math.round(starts[i + 2] + runs[i + 2].len / 2);
      if (verticalFits(cx, y, size)) centers.push({ x: cx, y, size });
    }
  }
  // Group hits of the same square; a QR has three squares of about the same size.
  const groups = [];
  for (const c of centers) {
    const g = groups.find((q) => Math.abs(q.x - c.x) < q.size / 2 && Math.abs(q.y - c.y) < q.size / 2);
    if (g) g.hits++; else groups.push({ ...c, hits: 1 });
  }
  const squares = groups.filter((g) => g.hits >= 2);
  return squares.some((a) => squares.filter((b) => b !== a && Math.abs(b.size - a.size) < a.size * 0.5).length >= 2);
}

/**
 * What identifies a transfer slip regardless of which order it is attached to:
 * the exact file (sha256) and the QR code Thai bank slips carry (it holds the
 * bank's transaction reference, so a re-screenshot or crop still matches).
 * The QR is best effort: null for WebP or when no QR is found. qrLike: the image has
 * QR corner squares that did not decode (see hasQrFinderPatterns).
 */
export function slipFingerprint(buf, mime) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  let qr = null, qrLike = false;
  try {
    const img = mime === 'image/png' ? PNG.sync.read(buf) : mime === 'image/jpeg' ? jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 }) : null;
    if (img) {
      qr = jsQR(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height)?.data?.trim() || null;
      if (!qr) qrLike = hasQrFinderPatterns(img);
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'slip QR not readable');
  }
  return { sha256, qr, qrLike };
}

/** Bank slip-verification QRs (EMVCo-style "00xx000600000101…"), as opposed to any other QR. */
export const isSlipQr = (qr) => typeof qr === 'string' && /^00\d{2}0006\d{6}01/.test(qr);

/** A clearer reason than the provider's "no QR", when we can tell what the image actually has. */
export function qrReason(fp) {
  if (fp.qrLike) return 'พบสิ่งที่ดูเหมือน QR บนภาพ แต่ไม่ใช่ QR จริง (สแกนอ่านไม่ได้) — สลิปจริงจากแอปธนาคารต้องมี QR ที่สแกนได้ ภาพนี้อาจถูกแต่งหรือปลอม หรือ QR ถูกบัง/เบลอ';
  if (fp.qr && !isSlipQr(fp.qr)) return 'พบ QR บนภาพ แต่ไม่ใช่ QR ตรวจสอบสลิปของธนาคาร — ส่งภาพสลิปจากแอปธนาคารที่มี QR สำหรับตรวจสอบการโอน';
  return null;
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
