import { internal as configOf } from '../config-admin/config.service.js';
import { BlockedUrlError, safeRequest } from '../shared/safe-fetch.js';

/**
 * Real slip verification against the provider chosen in Settings. Returns
 * { verified, amount, transRef, date, provider, message } — verified=null
 * means "no definitive answer" (provider off, unsupported or down), which
 * leaves the order for manual review.
 */
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

async function easyslip(cfg, buf, mime) {
  if (!cfg.easySlipApiKey) return { verified: null, message: 'ยังไม่ได้ตั้ง EasySlip API Key' };
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `slip.${EXT[mime] ?? 'jpg'}`);
  const r = await safeRequest('https://developer.easyslip.com/api/v1/verify', { headers: { authorization: `Bearer ${cfg.easySlipApiKey}` }, body: form });
  const j = JSON.parse(r.body || '{}');
  if (r.status === 200 && j.data) return { verified: true, amount: Number(j.data.amount?.amount), transRef: j.data.transRef ?? null, date: j.data.date ?? null, raw: j.data };
  // 400 = the slip itself is bad (not a slip / not found); anything else is the provider's problem.
  if (r.status === 400 || r.status === 404) return { verified: false, message: `EasySlip: ${j.message ?? 'สลิปไม่ถูกต้อง'}` };
  return { verified: null, message: `EasySlip ตอบ HTTP ${r.status}: ${j.message ?? ''}`.trim() };
}

async function slipok(cfg, buf, mime) {
  if (!cfg.slipOkApiKey || !cfg.slipOkBranchId) return { verified: null, message: 'ยังไม่ได้ตั้ง SlipOK API Key / Branch ID' };
  const form = new FormData();
  form.append('files', new Blob([buf], { type: mime }), `slip.${EXT[mime] ?? 'jpg'}`);
  const r = await safeRequest(`https://api.slipok.com/api/line/apikey/${encodeURIComponent(cfg.slipOkBranchId)}`, { headers: { 'x-authorization': cfg.slipOkApiKey }, body: form });
  const j = JSON.parse(r.body || '{}');
  if (r.status === 200 && j.success && j.data) return { verified: true, amount: Number(j.data.amount), transRef: j.data.transRef ?? null, date: j.data.transTimestamp ?? j.data.transDate ?? null, raw: j.data };
  if (r.status === 400) return { verified: false, message: `SlipOK: ${j.message ?? 'สลิปไม่ถูกต้อง'}` };
  return { verified: null, message: `SlipOK ตอบ HTTP ${r.status}: ${j.message ?? ''}`.trim() };
}

async function run(provider, cfg, buf, mime) {
  try {
    if (provider === 'easyslip') return { provider, ...(await easyslip(cfg, buf, mime)) };
    if (provider === 'slipok') return { provider, ...(await slipok(cfg, buf, mime)) };
    if (provider === 'none' || !provider) return { provider: 'none', verified: null, message: 'ไม่ได้เปิดการตรวจสลิป — รอผู้ดูแลตรวจ' };
    return { provider, verified: null, message: `ยังไม่รองรับการตรวจผ่าน ${provider} — รอผู้ดูแลตรวจ` };
  } catch (err) {
    return { provider, verified: null, message: err instanceof BlockedUrlError ? err.message : `ติดต่อ ${provider} ไม่ได้: ${err.name === 'TimeoutError' ? 'หมดเวลา' : err.message}` };
  }
}

/** Primary first; the fallback only when the primary gave no definitive answer (or a "not found" we were told to trust it on). */
export async function verifySlip(buf, mime) {
  const cfg = await configOf('slip');
  const first = await run(cfg.provider, cfg, buf, mime);
  if (first.verified !== null || !cfg.fallbackProvider || cfg.provider === 'none') return { ...first, cfg };
  const second = await run(cfg.fallbackProvider, cfg, buf, mime);
  if (second.verified === false && !cfg.failoverTrustNotFound) return { ...first, message: `${first.message} · ตัวสำรอง: ${second.message} (รอตัวหลักตรวจซ้ำ)`, cfg };
  return { ...second, cfg };
}

/**
 * QR demo page: verify a slip with the configured provider and look for the
 * pending order it would pay (same amount, same account when given).
 * Report only — nothing is approved from here.
 */
export async function demoVerify({ image, mime, bankAccountId }) {
  const { query } = await import('../db/pool.js');
  const buf = Buffer.from(image, 'base64');
  if (buf.length < 100 || buf.length > 8 << 20) return { verified: false, message: 'ไฟล์สลิปต้องเป็นรูปขนาดไม่เกิน 8 MB', matches: [] };
  const { cfg, ...v } = await verifySlip(buf, mime);
  let matches = [];
  if (v.verified && Number.isFinite(v.amount)) {
    const { rows } = await query(
      `SELECT p.ref, p.amount, p.created_at AS "createdAt", m.name AS "merchantName" FROM payments p LEFT JOIN merchants m ON m.id = p.merchant_id
        WHERE p.status = 'pending' AND p.amount = $1 AND ($2::int IS NULL OR p.bank_account_id = $2)
          AND p.created_at >= now() - make_interval(hours => $3) ORDER BY p.created_at DESC LIMIT 5`,
      [v.amount, bankAccountId ?? null, cfg.autoMatchTimeWindow],
    );
    matches = rows;
  }
  return { ...v, raw: undefined, matches };
}
