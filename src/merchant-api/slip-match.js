/**
 * Does a verified slip belong to this order? Compares what the slip provider
 * read from the bank (amount, receiver account/bank, sender name, time) with
 * the order. `problems` are definite mismatches (the slip is rejected, each one
 * a message the customer can act on); `unknown` lists checks the slip had no
 * data for (the order goes to manual review instead of being approved).
 */

// Thai interbank codes used by slip providers -> our bank codes.
const BANK_BY_ID = { '002': 'BBL', '004': 'KBANK', '006': 'KTB', '011': 'TTB', '014': 'SCB', '017': 'CITI', '018': 'SMBC', '020': 'SCBT', '022': 'CIMB', '024': 'UOB', '025': 'BAY', '029': 'IOB', '030': 'GSB', '031': 'HSBC', '032': 'DB', '033': 'GHB', '034': 'BAAC', '039': 'MHCB', '052': 'BOC', '066': 'ISBT', '067': 'TISCO', '069': 'KKP', '070': 'ICBC', '071': 'TCRB', '073': 'LHBANK', '079': 'ANZ', '080': 'SMTB', '098': 'SMEB' };
const bankCode = (bank) => {
  if (!bank) return null;
  const id = String(bank.id ?? bank).padStart(3, '0');
  return BANK_BY_ID[id] ?? (typeof bank.short === 'string' ? bank.short.toUpperCase() : null);
};
const names = (...v) => v.flat().filter((x) => typeof x === 'string' && x.trim());

/** Provider response -> one shape. EasySlip (data) and SlipOK (data) differ. */
export function normalizeSlip(provider, raw) {
  if (!raw) return null;
  if (provider === 'easyslip') {
    return {
      senderNames: names(raw.sender?.account?.name?.th, raw.sender?.account?.name?.en),
      senderAccount: raw.sender?.account?.bank?.account ?? raw.sender?.account?.proxy?.account ?? null,
      senderBank: bankCode(raw.sender?.bank),
      receiverNames: names(raw.receiver?.account?.name?.th, raw.receiver?.account?.name?.en),
      receiverAccount: raw.receiver?.account?.bank?.account ?? null,
      receiverProxy: raw.receiver?.account?.proxy?.account ?? null,
      receiverBank: bankCode(raw.receiver?.bank),
    };
  }
  if (provider === 'slipok') {
    return {
      senderNames: names(raw.sender?.displayName, raw.sender?.name),
      senderAccount: raw.sender?.account?.value ?? null,
      senderBank: bankCode(raw.sendingBank),
      receiverNames: names(raw.receiver?.displayName, raw.receiver?.name),
      receiverAccount: raw.receiver?.account?.value ?? null,
      receiverProxy: raw.receiver?.proxy?.value ?? null,
      receiverBank: bankCode(raw.receivingBank),
    };
  }
  return null;
}

/**
 * Masked slip account ("xxx-x-x6378-x") vs the full number: every visible digit
 * must be the same digit in the same place. Null = the slip shows no digits.
 */
export function accountMatches(masked, full) {
  const m = String(masked ?? '').toLowerCase().replace(/\*/g, 'x').replace(/[^0-9x]/g, '');
  const f = String(full ?? '').replace(/\D/g, '');
  if (!/\d/.test(m) || !f) return null;
  if (m.length === f.length) return [...m].every((ch, i) => ch === 'x' || ch === f[i]);
  // Different layout: each visible run of digits must appear, in order.
  let at = 0;
  for (const run of m.split('x').filter(Boolean)) {
    const i = f.indexOf(run, at);
    if (i < 0) return false;
    at = i + run.length;
  }
  return true;
}

const TITLES = /^(นางสาว|นาย|นาง|น\.ส\.?|ด\.ช\.?|ด\.ญ\.?|เด็กชาย|เด็กหญิง|บจก\.?|บริษัท|หจก\.?|mrs|mr|ms|miss|mstr|dr)\.?\s*/i;
const squash = (s) => s.toLowerCase().replace(/[\s.,'"()-]/g, '');
// With and without a leading title ("นายสมชาย" may be typed without a space; a name may itself start like a title).
const variants = (s) => [...new Set([squash(s.trim().replace(TITLES, '')), squash(s)])].filter((x) => x.length >= 2);

/**
 * Bank slips print the sender's name shortened ("นาย สมชาย ใ", "MR. SOMCHAI J"):
 * the order's name must start with what the slip shows (titles, spaces and dots ignored).
 */
export function nameMatches(slipNames, expected) {
  const want = variants(expected ?? '');
  const shown = slipNames.flatMap(variants);
  if (!want.length || !shown.length) return null;
  return shown.some((s) => want.some((w) => w.startsWith(s) || s.startsWith(w)));
}

const baht = (n) => `฿${Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const at = (d) => new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
/**
 * สถานะ text for a transfer made too long before the order: the one real reason, straight to the point (user, 22 Oct
 * 2026 — "ใช้สลิปเก่าไม่ได้" read like a reused slip). e.g. "โอนก่อนสร้างรายการ 3 ชม. 30 นาที (โอน 16:44 · สร้างรายการ 20:14) — เกินที่อนุญาต 15 นาที"
 */
export function earlyTransferText(transferAt, createdAt, allowedMin) {
  const mins = Math.max(0, Math.round((new Date(createdAt).getTime() - new Date(transferAt).getTime()) / 60_000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const gap = [d && `${d} วัน`, h && `${h} ชม.`, (m || !(d || h)) && `${m} นาที`].filter(Boolean).join(' ');
  const day = (x) => new Date(x).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const hm = (x) => new Date(x).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const when = (x) => (day(transferAt) === day(createdAt) ? hm(x) : at(x));
  return `โอนก่อนสร้างรายการ ${gap} (โอน ${when(transferAt)} · สร้างรายการ ${when(createdAt)}) — เกินที่อนุญาต ${allowedMin} นาที`;
}
const hasCustomer = (n) => !!n && n.trim() !== '-' && n.trim() !== '';

/** `order`: payment row joined with its receiving account (PAY_SELECT). `v`: verifySlip() result. */
export { hasCustomer };

export function matchSlip(v, order) {
  const problems = [];
  const unknown = [];
  const warnings = [];   // shown and kept on the order, but neither reject nor hold the slip
  let early = null;      // the "transfer before this order" problem (a carry-over may still accept it)
  const checks = [];     // every check with its outcome, for the caller (PASS / FAIL / WARN / UNKNOWN / SKIPPED)
  const check = (code, status, detail) => checks.push({ check: code, status, detail });
  const slip = normalizeSlip(v.provider, v.raw);

  // 1. Amount — to the satang. When "ยอดไม่ซ้ำ" added satang, the amount the shop asked for (requested_amount) is
  // accepted too: the customer paid what the shop showed, and the bank confirms it (the caller corrects the order).
  const requested = order.requested_amount == null ? null : Number(order.requested_amount);
  const paidRequested = requested != null && Math.abs(requested - Number(order.amount)) > 0.009 && Math.abs(Number(v.amount) - requested) <= 0.009;
  if (paidRequested) {
    check('AMOUNT', 'PASS', `ยอดในสลิป ${baht(v.amount)} ตรงกับยอดที่ร้านสั่ง (ระบบเติมสตางค์เป็น ${baht(order.amount)}) — ปรับยอดออเดอร์เป็นยอดที่ได้รับจริง`);
  } else if (Math.abs(Number(v.amount) - Number(order.amount)) > 0.009) {
    problems.push(`ยอดเงินในสลิป ${baht(v.amount)} ไม่ตรงกับยอดที่ต้องชำระ ${baht(order.amount)} — ต้องโอนตรงยอดทุกสตางค์`);
    check('AMOUNT', 'FAIL', `ยอดในสลิป ${baht(v.amount)} แต่ออเดอร์ต้องชำระ ${baht(order.amount)} (${Number(v.amount) > Number(order.amount) ? 'โอนเกิน' : 'โอนขาด'} ${baht(Math.abs(Number(v.amount) - Number(order.amount)))})`);
  } else check('AMOUNT', 'PASS', `ยอดในสลิป ${baht(v.amount)} ตรงกับยอดออเดอร์`);

  // 2. Transfer time — not before the order existed, beyond the allowance (ตั้งค่า → ตรวจสลิป: earlyTransferMinutes,
  // default 15 — customers who pay first and open the order a few minutes later; was a fixed 10 until 20 Oct 2026).
  const earlyMin = Number(v.cfg?.earlyTransferMinutes ?? 15);
  if (v.date && new Date(v.date).getTime() < new Date(order.created_at).getTime() - earlyMin * 60_000) {
    early = earlyTransferText(v.date, order.created_at, earlyMin);
    problems.push(early);
    check('TRANSFER_TIME', 'FAIL', `โอนเมื่อ ${at(v.date)} — ก่อนสร้างออเดอร์ (${at(order.created_at)}) เกิน ${earlyMin} นาที`);
  } else if (v.date) check('TRANSFER_TIME', 'PASS', `โอนเมื่อ ${at(v.date)} — หลังสร้างออเดอร์ (${at(order.created_at)})`);
  else check('TRANSFER_TIME', 'UNKNOWN', 'สลิปไม่มีเวลาโอน');

  // 3. Receiver — this order's account (bank + number, or its PromptPay).
  const expectedAcct = `${order.acct_bank} ${order.account_no} (${order.account_name})`;
  const shownTo = `${slip?.receiverBank ?? ''} ${slip?.receiverAccount ?? slip?.receiverProxy ?? ''}`.trim();
  const before = problems.length + unknown.length;
  if (slip?.receiverBank && order.acct_bank && slip.receiverBank !== order.acct_bank) {
    problems.push(`โอนเข้าธนาคาร ${slip.receiverBank} แต่รายการนี้ต้องโอนเข้า ${expectedAcct}`);
  } else {
    const byAccount = accountMatches(slip?.receiverAccount, order.account_no);
    const byProxy = order.promptpay_id ? accountMatches(slip?.receiverProxy, order.promptpay_id) : null;
    if (byAccount === true || byProxy === true) { /* ok */ }
    else if (byAccount === false || byProxy === false) {
      problems.push(`บัญชีผู้รับในสลิป (${slip.receiverAccount ?? slip.receiverProxy}) ไม่ใช่บัญชีของรายการนี้ — ต้องโอนเข้า ${expectedAcct}`);
    } else {
      // No digits on the slip: fall back to the receiver's name.
      const byName = nameMatches(slip?.receiverNames ?? [], order.account_name);
      if (byName === false) problems.push(`ชื่อผู้รับในสลิป (${slip.receiverNames[0]}) ไม่ตรงกับบัญชีของรายการนี้ — ต้องโอนเข้า ${expectedAcct}`);
      else if (byName === null) unknown.push('อ่านบัญชีผู้รับในสลิปไม่ได้');
    }
  }
  if (problems.length + unknown.length === before) check('RECEIVER_ACCOUNT', 'PASS', `โอนเข้า ${shownTo || 'บัญชี'} — ตรงกับบัญชีของออเดอร์ (${expectedAcct})`);
  else if (unknown.length && problems.length + unknown.length === before + 1 && unknown.at(-1) === 'อ่านบัญชีผู้รับในสลิปไม่ได้') check('RECEIVER_ACCOUNT', 'UNKNOWN', 'สลิปไม่แสดงบัญชีผู้รับ — รอเจ้าหน้าที่ตรวจ');
  else check('RECEIVER_ACCOUNT', 'FAIL', problems.at(-1));

  // 4. Sender — the customer named on the order (when the shop entered one). Someone else may pay
  // for the customer (husband for wife…), so a different name is only a warning: the money still reached
  // this order's account, in full, after it was created — and the slip can't pay another order.
  if (hasCustomer(order.customer_name)) {
    const bySender = nameMatches(slip?.senderNames ?? [], order.customer_name);
    if (bySender === false) warnings.push(`ชื่อผู้โอนในสลิป (${slip.senderNames[0]}) ไม่ตรงกับชื่อลูกค้า (${order.customer_name}) — อาจโอนแทนกัน`);
    else if (bySender === null) warnings.push('อ่านชื่อผู้โอนในสลิปไม่ได้ — ยืนยันผู้โอนไม่ได้');
    check('SENDER_NAME', bySender === true ? 'PASS' : 'WARN',
      bySender === true ? `ผู้โอน ${slip.senderNames[0]} ตรงกับชื่อลูกค้า` : warnings.at(-1) + ' (ไม่ทำให้สลิปไม่ผ่าน)');
  } else check('SENDER_NAME', 'SKIPPED', 'ออเดอร์ไม่ได้ระบุชื่อลูกค้า — ไม่ตรวจชื่อผู้โอน');

  return { problems, unknown, warnings, early, checks, paidRequested };
}
