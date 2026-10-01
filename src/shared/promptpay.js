/**
 * Thai PromptPay QR payload (EMVCo merchant-presented, tag 29) with the amount
 * embedded. `id` is a 10-digit mobile number, 13-digit national/tax id or a
 * 15-digit e-wallet id.
 */
const f = (tag, value) => `${tag}${String(value.length).padStart(2, '0')}${value}`;

function crc16(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function normalizePromptPayId(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d) || /^\d{13}$/.test(d) || /^\d{15}$/.test(d)) return d;
  return null;
}

export function promptPayPayload(rawId, amount) {
  const id = normalizePromptPayId(rawId);
  if (!id) return null;
  const target = id.length === 10 ? f('01', `0066${id.slice(1)}`) : id.length === 13 ? f('02', id) : f('03', id);
  const body =
    f('00', '01') +
    f('01', amount ? '12' : '11') +
    f('29', f('00', 'A000000677010111') + target) +
    f('53', '764') +
    (amount ? f('54', Number(amount).toFixed(2)) : '') +
    f('58', 'TH') +
    '6304';
  return body + crc16(body);
}
