import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import logger from '../logger.js';
import { readQr } from './slip-qr.js';

export { hasQrFinderPatterns } from './slip-qr.js';

// Image decode + QR scan is pure JS (a few hundred ms on a phone screenshot): it runs in worker threads so a slip
// upload doesn't stall every other request. Any worker problem falls back to reading the QR on this thread.
const POOL = 2;
const JOB_TIMEOUT_MS = 15_000;
const workers = [];
const pending = new Map();
let nextId = 0, turn = 0;

function spawn(slot) {
  const w = new Worker(new URL('./slip-qr.worker.js', import.meta.url));
  w.unref();
  w.on('message', ({ id, ...out }) => { const job = pending.get(id); if (job) { pending.delete(id); clearTimeout(job.timer); job.done(out); } });
  const drop = (err) => {
    if (workers[slot] === w) workers[slot] = null;
    for (const [id, job] of pending) if (job.worker === w) { pending.delete(id); clearTimeout(job.timer); job.done({ error: err?.message ?? 'worker exited' }); }
  };
  w.on('error', drop);
  w.on('exit', () => drop());
  return (workers[slot] = w);
}

function readQrOffThread(buf, mime) {
  const slot = turn++ % POOL;
  const w = workers[slot] ?? spawn(slot);
  const id = ++nextId;
  return new Promise((done) => {
    const timer = setTimeout(() => { pending.delete(id); w.terminate(); done({ error: 'timeout' }); }, JOB_TIMEOUT_MS);
    pending.set(id, { worker: w, timer, done });
    // A copy goes to the worker; the caller keeps its buffer (it is stored with the slip).
    w.postMessage({ id, buf: new Uint8Array(buf), mime });
  });
}

/**
 * What identifies a transfer slip regardless of which order it is attached to:
 * the exact file (sha256) and the QR code Thai bank slips carry (it holds the
 * bank's transaction reference, so a re-screenshot or crop still matches).
 * The QR is best effort: null for WebP or when no QR is found. qrLike: the image has
 * QR corner squares that did not decode (see hasQrFinderPatterns).
 */
export async function slipFingerprint(buf, mime) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (mime !== 'image/png' && mime !== 'image/jpeg') return { sha256, qr: null, qrLike: false };
  let out = await readQrOffThread(buf, mime);
  if (out.error && out.error !== 'timeout') {
    logger.warn({ err: out.error }, 'slip QR worker failed — reading on the main thread');
    try { out = readQr(buf, mime); } catch (err) { out = { error: err.message }; }
  }
  if (out.error) {
    logger.debug({ err: out.error }, 'slip QR not readable');
    return { sha256, qr: null, qrLike: false };
  }
  return { sha256, qr: out.qr, qrLike: out.qrLike };
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
 * Slips rejected on their order don't count: the transfer was not applied there — unless an admin approved that
 * order anyway (its slip still reads "invalid", but the transfer did pay it).
 * Takes per-fingerprint advisory locks so two uploads of one slip can't race.
 */
export async function findReusedSlip(c, paymentId, { sha256, qr }) {
  for (const key of [sha256, qr].filter(Boolean).sort()) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`slip:${key}`]);
  const { rows } = await c.query(
    `SELECT p.ref FROM payment_slips s JOIN payments p ON p.id = s.payment_id
      WHERE s.payment_id <> $1 AND (s.image_sha256 = $2 OR (s.qr_payload IS NOT NULL AND s.qr_payload = $3))
        AND (coalesce(s.verify_result->>'decision', '') <> 'invalid' OR p.status IN ('approved', 'refunded'))
      ORDER BY s.uploaded_at LIMIT 1`,
    [paymentId, sha256, qr],
  );
  return rows[0]?.ref ?? null;
}
