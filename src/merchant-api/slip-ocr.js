import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';
import logger from '../logger.js';
import { accountMatches, earlyTransferText } from './slip-match.js';

/**
 * Reads a slip image with OCR (Thai + English) when no slip provider is
 * connected, and compares what is printed with the order. Pixels can be
 * edited, so this never approves: clear mismatches in the numbers (amount,
 * receiving account, transfer time) reject the slip; everything else goes to
 * the admin with what matched and what could not be confirmed.
 */
const LANG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/ocr');

let worker = null;
function getWorker() {
  // One worker, loaded on first use (~5 s), then ~1 s per slip; calls are queued.
  // errorHandler: tesseract.js otherwise throws job errors outside the promise, which would crash the server.
  worker ??= createWorker(['tha', 'eng'], 1, { langPath: LANG_DIR, gzip: false, cacheMethod: 'none', logger: () => {},
    errorHandler: (err) => logger.warn({ err: String(err?.message ?? err) }, 'slip OCR worker error') })
    .catch((err) => { worker = null; throw err; });
  return worker;
}

export async function readSlipText(buf) {
  const w = await getWorker();
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 30_000));
  const { data } = await Promise.race([w.recognize(buf), timeout]);
  return data.text;
}

// ---------- parsing ----------

const norm = (t) => t.replace(/ํา/g, 'ำ').replace(/[ \t]+/g, ' ');
const MONEY = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g;
const TH_MONTHS = [['มกราคม', 'ม.ค.'], ['กุมภาพันธ์', 'ก.พ.'], ['มีนาคม', 'มี.ค.'], ['เมษายน', 'เม.ย.'], ['พฤษภาคม', 'พ.ค.'], ['มิถุนายน', 'มิ.ย.'],
  ['กรกฎาคม', 'ก.ค.'], ['สิงหาคม', 'ส.ค.'], ['กันยายน', 'ก.ย.'], ['ตุลาคม', 'ต.ค.'], ['พฤศจิกายน', 'พ.ย.'], ['ธันวาคม', 'ธ.ค.']];
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const BANK_WORDS = {
  SCB: ['ไทยพาณิชย์', 'scb'], KBANK: ['กสิกร', 'kbank', 'k plus', 'kasikorn'], BBL: ['กรุงเทพ', 'bangkok bank', 'bualuang'],
  KTB: ['กรุงไทย', 'krungthai', 'krung thai'], BAY: ['กรุงศรี', 'krungsri'], TTB: ['ทหารไทย', 'ทีทีบี', 'ttb'],
};

/** Bangkok wall-clock -> Date. Years: BE (2569 / 69) or CE (2026 / 26). */
function bkk(d, m, y, hh, mm) {
  let year = Number(y);
  if (year < 100) year = year >= 50 ? 2500 + year : 2000 + year;
  if (year > 2400) year -= 543;
  const t = Date.UTC(year, m - 1, Number(d), Number(hh) - 7, Number(mm));
  return Number.isFinite(t) && m >= 1 && m <= 12 ? new Date(t) : null;
}

export function parseSlipDate(text) {
  const t = norm(text);
  const time = String.raw`[^\d]{0,12}(\d{1,2})\s*[:.]\s*(\d{2})`;
  for (const [i, [full, short]] of TH_MONTHS.entries()) {
    const abbr = short.replace(/\./g, '\\.?\\s*');
    const re = new RegExp(String.raw`(\d{1,2})\s*(?:${full}|${abbr})\s*(\d{2,4})${time}`);
    const x = re.exec(t);
    if (x) return bkk(x[1], i + 1, x[2], x[3], x[4]);
  }
  const en = new RegExp(String.raw`(\d{1,2})\s+(${EN_MONTHS.join('|')})[a-z]*\.?,?\s+(\d{2,4})${time}`, 'i').exec(t);
  if (en) return bkk(en[1], EN_MONTHS.indexOf(en[2].toLowerCase()) + 1, en[3], en[4], en[5]);
  const num = new RegExp(String.raw`(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})${time}`).exec(t);
  if (num) return bkk(num[1], Number(num[2]), num[3], num[4], num[5]);
  return null;
}

export function parseSlip(text) {
  const lines = norm(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const isRef = (l) => /อ้างอิง|เลขที่รายการ|ref/i.test(l);
  const isFee = (l) => /ค่าธรรมเนียม|fee/i.test(l);
  const money = (l) => [...l.matchAll(MONEY)].map((x) => Number(`${x[1].replace(/,/g, '')}.${x[2]}`));

  // Amount: the labelled line (or the line after it) first; else any amount on the slip.
  let labelled = [];
  lines.forEach((l, i) => {
    if (/จำนวน|ยอดเงิน|ยอดโอน|amount/i.test(l) && !isFee(l)) labelled.push(...money(l), ...(money(l).length ? [] : money(lines[i + 1] ?? '')));
  });
  labelled = labelled.filter((n) => n > 0);
  const anyAmounts = lines.filter((l) => !isFee(l) && !isRef(l)).flatMap(money).filter((n) => n > 0);

  // Accounts: masked numbers like XXX-XXX637-8, in the order printed.
  const fromAt = lines.findIndex((l) => /^(จาก|from|ผู้โอน)\b|^จาก/i.test(l));
  const toAt = lines.findIndex((l) => /^(ไปยัง|ถึง|to|ผู้รับ)\b|^ไปยัง|^ถึง/i.test(l));
  const accounts = [];
  lines.forEach((l, i) => {
    if (isRef(l)) return;
    for (const x of l.matchAll(/[Xx*•\d][Xx*•\d\- ]{7,}[Xx*•\d]/g)) {
      const clean = x[0].replace(/[*•]/g, 'x').replace(/[^0-9xX]/g, '').toLowerCase();
      if (clean.length >= 9 && clean.length <= 16 && /\d/.test(clean)) accounts.push({ value: x[0].trim(), line: i });
    }
  });
  let receiver = toAt >= 0 ? accounts.find((a) => a.line >= toAt) : null;
  if (!receiver && accounts.length >= 2) receiver = accounts[1];

  // Names: text after the "from" / "to" label (or the next line), symbols dropped.
  const nameAt = (i) => {
    if (i < 0) return null;
    const after = lines[i].replace(/^(จาก|from|ผู้โอน|ไปยัง|ถึง|to|ผู้รับ)\s*:?/i, '').replace(/^[^ก-๙A-Za-z]+/, '').trim();
    return after || (lines[i + 1] ?? '').replace(/^[^ก-๙A-Za-z]+/, '').trim() || null;
  };

  const lower = lines.join(' ').toLowerCase();
  const banks = Object.entries(BANK_WORDS).filter(([, words]) => words.some((w) => lower.includes(w))).map(([code]) => code);
  return { amounts: labelled.length ? labelled : anyAmounts, amountLabelled: labelled.length > 0, accounts: accounts.map((a) => a.value), receiverAccount: receiver?.value ?? null, sender: nameAt(fromAt), receiverName: nameAt(toAt), date: parseSlipDate(text), banks };
}

// ---------- comparison ----------

const TITLE = /^(นางสาว|นาย|นาง|น\.ส\.?|งาย|บริษัท|ริษัท|บจก\.?|mrs|mr|ms|miss)\.?\s*/i;
const squash = (s) => s.toLowerCase().replace(/[\s.,'"()\-@]/g, '');
const firstName = (s) => squash((s.trim().replace(TITLE, '').split(/\s+/)[0]) ?? '');
const baht = (n) => `฿${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const at = (d) => new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });

/**
 * `problems`: definite mismatches in the numbers (the slip is rejected).
 * `flags`: things the admin should look at. `matched`: what was confirmed.
 */
export function compareOcr(s, order, cfg = {}) {
  const problems = [];
  const flags = [];
  const matched = [];
  const amount = Number(order.amount);

  if (!s.amounts.length) flags.push('อ่านยอดเงินในสลิปไม่ได้');
  else if (s.amounts.some((n) => Math.abs(n - amount) < 0.005)) matched.push(`ยอด ${baht(amount)}`);
  // The shop's amount before "ยอดไม่ซ้ำ" satang were added: not a mismatch (an admin confirms it — images are never approved).
  else if (order.requested_amount != null && s.amounts.some((n) => Math.abs(n - Number(order.requested_amount)) < 0.005)) flags.push(`ยอดในสลิป ${baht(Number(order.requested_amount))} = ยอดที่ร้านสั่ง (ระบบเติมสตางค์เป็น ${baht(amount)})`);
  else problems.push(`ยอดเงินในสลิป ${baht(s.amounts[0])} ไม่ตรงกับยอดที่ต้องชำระ ${baht(amount)} — ต้องโอนตรงยอดทุกสตางค์`);

  const expectedAcct = `${order.acct_bank} ${order.account_no} (${order.account_name})`;
  const fits = (v) => accountMatches(v, order.account_no) === true || (order.promptpay_id && accountMatches(v, order.promptpay_id) === true);
  // Only the receiver's number counts (the sender's could fit by chance); any number only when roles are unclear.
  if (s.receiverAccount ? fits(s.receiverAccount) : s.accounts.some(fits)) matched.push(`บัญชีผู้รับ ${order.account_no}`);
  else if (s.receiverAccount) problems.push(`บัญชีผู้รับในสลิป (${s.receiverAccount}) ไม่ใช่บัญชีของรายการนี้ — ต้องโอนเข้า ${expectedAcct}`);
  else flags.push('อ่านเลขบัญชีผู้รับในสลิปไม่ได้');

  if (s.banks.includes(order.acct_bank)) matched.push(`ธนาคาร ${order.acct_bank}`);
  else flags.push(`ยืนยันธนาคารผู้รับ (${order.acct_bank}) จากภาพไม่ได้`);

  const customer = order.customer_name && order.customer_name.trim() !== '-' ? order.customer_name.trim() : null;
  if (customer) {
    const want = firstName(customer);
    if (!s.sender) flags.push('อ่านชื่อผู้โอนในสลิปไม่ได้');
    else if (want.length >= 2 && squash(s.sender).includes(want)) matched.push(`ผู้โอน ${customer}`);
    else flags.push(`ชื่อผู้โอนในสลิป (${s.sender}) อาจไม่ตรงกับชื่อลูกค้า (${customer}) — ให้ผู้ดูแลตรวจ`);
  }

  if (!s.date) flags.push('อ่านวันเวลาที่โอนในสลิปไม่ได้');
  else {
    // Slips print minutes; a transfer up to `earlyTransferMinutes` (default 15) before the order still counts.
    const slipEnd = s.date.getTime() + 60_000;
    if (slipEnd < new Date(order.created_at).getTime() - Number(cfg.earlyTransferMinutes ?? 15) * 60_000) {
      problems.push(earlyTransferText(s.date, order.created_at, Number(cfg.earlyTransferMinutes ?? 15)));
    } else if (cfg.slipAgeCheck && cfg.slipMaxAgeHours > 0 && Date.now() - s.date.getTime() > cfg.slipMaxAgeHours * 3_600_000) {
      problems.push(`สลิปเก่าเกิน ${cfg.slipMaxAgeHours} ชั่วโมง — ใช้สลิปเก่าไม่ได้`);
    } else matched.push(`เวลาโอน ${at(s.date)}`);
  }
  return { problems, flags, matched };
}

/** OCR + compare; null when the image can't be read at all (left for the admin). */
/** Only images our own decoders accept go to OCR (a malformed file is left for the admin). */
function decodable(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) { PNG.sync.read(buf); return true; }
    if (buf[0] === 0xff && buf[1] === 0xd8) { jpeg.decode(buf, { maxResolutionInMP: 40, maxMemoryUsageInMB: 256 }); return true; }
    return buf.subarray(8, 12).toString('ascii') === 'WEBP';
  } catch {
    return false;
  }
}

export async function ocrCheckSlip(buf, order, cfg) {
  if (!decodable(buf)) return null;
  try {
    const text = await readSlipText(buf);
    const parsed = parseSlip(text);
    return { ...compareOcr(parsed, order, cfg), parsed: { ...parsed, date: parsed.date?.toISOString() ?? null } };
  } catch (err) {
    logger.warn({ err: err.message }, 'slip OCR failed');
    return null;
  }
}
