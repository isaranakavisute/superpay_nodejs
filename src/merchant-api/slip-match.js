/**
 * Does a verified slip belong to this order? Compares what the slip provider
 * read from the bank (amount, receiver account/bank, sender name, time) with
 * the order. `problems` are definite mismatches (the slip is rejected, each one
 * a message the customer can act on); `unknown` lists checks the slip had no
 * data for (the order goes to manual review instead of being approved).
 */

// Thai interbank codes used by slip providers -> our bank codes.
const BANK_BY_ID = { '002': 'BBL', '004': 'KBANK', '006': 'KTB', '011': 'TTB', '014': 'SCB', '025': 'BAY', '022': 'CIMB', '024': 'UOB', '030': 'GSB', '034': 'BAAC', '067': 'TISCO', '069': 'KKP', '073': 'LHB' };
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
      receiverNames: names(raw.receiver?.account?.name?.th, raw.receiver?.account?.name?.en),
      receiverAccount: raw.receiver?.account?.bank?.account ?? null,
      receiverProxy: raw.receiver?.account?.proxy?.account ?? null,
      receiverBank: bankCode(raw.receiver?.bank),
    };
  }
  if (provider === 'slipok') {
    return {
      senderNames: names(raw.sender?.displayName, raw.sender?.name),
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
const hasCustomer = (n) => !!n && n.trim() !== '-' && n.trim() !== '';

/** `order`: payment row joined with its receiving account (PAY_SELECT). `v`: verifySlip() result. */
export function matchSlip(v, order) {
  const problems = [];
  const unknown = [];
  const slip = normalizeSlip(v.provider, v.raw);

  // 1. Amount — to the satang.
  if (Math.abs(Number(v.amount) - Number(order.amount)) > 0.009) {
    problems.push(`ยอดเงินในสลิป ${baht(v.amount)} ไม่ตรงกับยอดที่ต้องชำระ ${baht(order.amount)} — ต้องโอนตรงยอดทุกสตางค์`);
  }

  // 2. Transfer time — not before the order existed (10 min clock tolerance).
  if (v.date && new Date(v.date).getTime() < new Date(order.created_at).getTime() - 10 * 60_000) {
    problems.push(`สลิปทำรายการเมื่อ ${at(v.date)} ก่อนสร้างรายการนี้ (${at(order.created_at)}) — ใช้สลิปเก่าไม่ได้`);
  }

  // 3. Receiver — this order's account (bank + number, or its PromptPay).
  const expectedAcct = `${order.acct_bank} ${order.account_no} (${order.account_name})`;
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

  // 4. Sender — the customer named on the order (when the shop entered one).
  if (hasCustomer(order.customer_name)) {
    const bySender = nameMatches(slip?.senderNames ?? [], order.customer_name);
    if (bySender === false) problems.push(`ชื่อผู้โอนในสลิป (${slip.senderNames[0]}) ไม่ตรงกับชื่อลูกค้าของรายการ (${order.customer_name}) — ต้องโอนจากบัญชีของลูกค้าที่ระบุ`);
    else if (bySender === null) unknown.push('อ่านชื่อผู้โอนในสลิปไม่ได้');
  }

  return { problems, unknown };
}
