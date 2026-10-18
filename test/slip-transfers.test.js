// Left-over of a bank transfer: a transfer that an admin approved for LESS than its amount may pay exactly one more
// order the left-over covers (one at a time until it is used up), same shop / account / customer, within the time limit
// (17 Oct 2026, นราวดี สีพล).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeUsedUp, leftoverChecks, leftoverFor, recordUse } from '../src/merchant-api/slip-transfers.js';

const hour = 3_600_000;
const transfer = (over = {}) => ({ id: 7, trans_ref: '2026101617010423004972708', amount: '1500.00', used: '500.00', merchant_id: 58, bank_account_id: 19,
  transfer_at: new Date(Date.now() - 2 * hour), leftover_until: new Date(Date.now() + 22 * hour), ...over });
const order = (over = {}) => ({ amount: '1000.00', merchant_id: 58, bank_account_id: 19, customer_name: 'นราวดี สีพล', payer_account_masked: '···9631',
  metadata: { senderAccountNumber: '5577189631' }, ...over });
const slip = { senderNames: ['MS NARAWADEE S'], senderAccount: '557-7-xxx631' };

describe('leftoverFor', () => {
  it('a transfer that never paid an order is left to the normal checks', () => {
    assert.equal(leftoverFor(null, order(), slip), null);
    assert.equal(leftoverFor(transfer({ used: '0' }), order(), slip), null);
  });
  it('accepts an order of exactly the left-over from the same customer, shop and account (2.1)', () => {
    assert.deepEqual(leftoverFor(transfer(), order(), slip), { ok: true, left: 1000, after: 0 });
  });
  it('accepts a smaller order the left-over covers; the rest stays (2.2: ฿200 → ฿800 left)', () => {
    assert.deepEqual(leftoverFor(transfer(), order({ amount: '200.00' }), slip), { ok: true, left: 1000, after: 800 });
  });
  it('refuses an order above the left-over and tells the shop the most it can be (2.3: ฿2,000)', () => {
    const r = leftoverFor(transfer(), order({ amount: '2000.00' }), slip);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'AMOUNT');
    assert.match(r.hint, /ไม่เกิน ฿1,000\.00/);
  });
  it('refuses the full slip amount again (would count the money twice)', () => {
    assert.equal(leftoverFor(transfer(), order({ amount: '1500.00' }), slip).ok, false);
  });
  it('refuses another shop or receiving account', () => {
    assert.equal(leftoverFor(transfer(), order({ merchant_id: 59 }), slip).reason, 'OTHER_SHOP');
    assert.equal(leftoverFor(transfer(), order({ bank_account_id: 20 }), slip).reason, 'OTHER_SHOP');
  });
  it('refuses another customer', () => {
    const other = order({ customer_name: 'สมชาย ใจดี', payer_account_masked: '···1111', metadata: {} });
    assert.equal(leftoverFor(transfer(), other, slip).reason, 'CUSTOMER');
  });
  it('refuses after the time limit', () => {
    assert.equal(leftoverFor(transfer({ leftover_until: new Date(Date.now() - 1000) }), order(), slip).reason, 'EXPIRED');
    assert.equal(leftoverFor(transfer({ leftover_until: null }), order(), slip).reason, 'EXPIRED');
  });
  it('refuses a used-up transfer', () => {
    assert.deepEqual(leftoverFor(transfer({ used: '1500.00' }), order(), slip), { ok: false, left: 0, reason: 'USED_UP' });
  });
});

describe('leftoverChecks', () => {
  it('reports amount and transfer time against the left-over', () => {
    const lo = { left: 1000, after: 800, paid: [{ ref: 'TXN173429', amount: 500 }] };
    const out = leftoverChecks([
      { check: 'AMOUNT', status: 'PASS', detail: 'x' },
      { check: 'TRANSFER_TIME', status: 'FAIL', detail: 'โอนก่อนสร้างออเดอร์' },
      { check: 'RECEIVER_ACCOUNT', status: 'PASS', detail: 'ok' },
    ], lo, { amount: 1500 });
    assert.equal(out[0].status, 'PASS');
    assert.match(out[0].detail, /TXN173429/);
    assert.match(out[0].detail, /800\.00/);
    assert.equal(out[1].status, 'PASS');
    assert.deepEqual(out[2], { check: 'RECEIVER_ACCOUNT', status: 'PASS', detail: 'ok' });
  });
});

/** A small in-memory stand-in for the queries recordUse / closeUsedUp run. */
function fakeDb({ slips }) {
  const transfers = [];
  const uses = [];
  const q = async (sql, args = []) => {
    if (/FROM payments p JOIN payment_slips s/.test(sql)) return { rows: slips[args[0]] ? [slips[args[0]]] : [] };
    if (/INSERT INTO slip_transfers/.test(sql)) {
      if (!transfers.find((t) => t.trans_ref === args[0])) {
        transfers.push({ id: transfers.length + 1, trans_ref: args[0], amount: String(args[1]), used: '0', merchant_id: args[2], bank_account_id: args[3] });
      }
      return { rows: [] };
    }
    if (/FROM slip_transfers WHERE trans_ref/.test(sql)) return { rows: transfers.filter((t) => t.trans_ref === args[0]).map((t) => ({ ...t })) };
    if (/SELECT amount FROM slip_transfer_uses WHERE payment_id/.test(sql)) return { rows: uses.filter((u) => u.payment_id === args[0]) };
    if (/INSERT INTO slip_transfer_uses/.test(sql)) { uses.push({ transfer_id: args[0], payment_id: args[1], amount: args[2], kind: args[3] }); return { rows: [] }; }
    if (/UPDATE slip_transfers SET used/.test(sql)) {
      const t = transfers.find((x) => x.id === args[0]);
      const used = Math.round((Number(t.used) + args[1]) * 100) / 100;
      if (used > Number(t.amount)) throw new Error('violates check constraint slip_transfers_used_within_amount');
      t.used = String(used);
      return { rows: [{ ...t }] };
    }
    if (/UPDATE payment_slips SET trans_ref/.test(sql)) return { rows: [] };
    if (/count\(\*\)::int AS n FROM slip_transfer_uses/.test(sql)) return { rows: [{ n: uses.filter((u) => u.transfer_id === args[0]).length }] };
    if (/FROM slip_transfer_uses u JOIN payments p/.test(sql)) return { rows: uses.filter((u) => u.transfer_id === args[0]).map((u) => ({ ref: `P${u.payment_id}`, amount: u.amount })) };
    if (/WITH due AS/.test(sql)) return { rows: [{ ref: 'TXN173893', was: 'expired' }] };
    if (/coverTransferId/.test(sql) || /FROM slip_transfers t\s+JOIN LATERAL/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return { c: { query: q }, transfers, uses };
}

const vr = (amount, extra = {}) => ({ verified: true, amount, transRef: 'REF1', date: new Date().toISOString(), ...extra });

describe('recordUse', () => {
  it('admin approves ฿500 with a ฿1,500 slip → ฿1,000 left; the ฿1,000 left-over order then uses it up', async () => {
    const db = fakeDb({ slips: {
      1: { id: 1, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) },
      2: { id: 2, amount: '1000.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) },
    } });
    const a = await recordUse(db.c, 1, 'admin');
    assert.equal(a.kind, 'partial');
    assert.equal(a.take, 500);
    assert.equal(Number(a.transfer.used), 500);
    assert.deepEqual(await closeUsedUp(db.c, a, 1), [], 'nothing is closed while money is left');
    const b = await recordUse(db.c, 2, 'system');
    assert.equal(b.kind, 'leftover');
    assert.equal(b.take, 1000);
    assert.equal(Number(b.transfer.used), 1500);
    assert.deepEqual(await closeUsedUp(db.c, b, 2), [{ ref: 'TXN173893', was: 'expired' }], 'the order the transfer was first sent for is closed');
  });
  it('left-over used in steps: ฿200 then ฿800; the refused first order is closed only when nothing is left', async () => {
    const db = fakeDb({ slips: {
      1: { id: 1, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) },
      2: { id: 2, amount: '200.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) },
      3: { id: 3, amount: '800.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) },
    } });
    await recordUse(db.c, 1, 'admin');
    const b = await recordUse(db.c, 2, 'system');
    assert.equal(b.take, 200);
    assert.equal(Number(b.transfer.used), 700);
    assert.deepEqual(await closeUsedUp(db.c, b, 2), []);
    const c = await recordUse(db.c, 3, 'system');
    assert.equal(Number(c.transfer.used), 1500);
    assert.equal((await closeUsedUp(db.c, c, 3)).length, 1);
  });
  it('a normal approval uses the whole transfer and closes nothing extra', async () => {
    const db = fakeDb({ slips: { 1: { id: 1, amount: '1500.00', merchant_id: 58, bank_account_id: 19, trans_ref: 'REF1', vr: vr(1500) } } });
    const a = await recordUse(db.c, 1, 'system');
    assert.equal(a.kind, 'full');
    assert.deepEqual(await closeUsedUp(db.c, a, 1), []);
  });
  it('an admin approving more than is left takes only what is left (never above the transfer)', async () => {
    const db = fakeDb({ slips: {
      1: { id: 1, amount: '1500.00', merchant_id: 58, bank_account_id: 19, trans_ref: 'REF1', vr: vr(1500) },
      2: { id: 2, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) },
    } });
    await recordUse(db.c, 1, 'system');
    const b = await recordUse(db.c, 2, 'admin');
    assert.equal(b.kind, 'over_used');
    assert.equal(b.take, 0);
    assert.equal(db.transfers[0].used, '1500');
  });
  it('an underpaid slip approved by an admin uses the transfer up, never below zero', async () => {
    const db = fakeDb({ slips: { 1: { id: 1, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: 'REF1', vr: vr(300) } } });
    const a = await recordUse(db.c, 1, 'admin');
    assert.equal(a.take, 300);
    assert.equal(a.kind, 'full');
  });
  it('approving the same order twice records it once', async () => {
    const db = fakeDb({ slips: { 1: { id: 1, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(1500) } } });
    await recordUse(db.c, 1, 'admin');
    await recordUse(db.c, 1, 'admin');
    assert.equal(db.uses.length, 1);
    assert.equal(db.transfers[0].used, '500');
  });
  it('slips the bank did not verify (image read only / no transRef) are not tracked', async () => {
    const db = fakeDb({ slips: {
      1: { id: 1, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: { verified: null, amount: null } },
      2: { id: 2, amount: '500.00', merchant_id: 58, bank_account_id: 19, trans_ref: null, vr: vr(500, { transRef: undefined }) },
    } });
    assert.equal(await recordUse(db.c, 1, 'admin'), null);
    assert.equal(await recordUse(db.c, 2, 'admin'), null);
  });
});

describe('no slip: a new order paid from the left-over at creation', async () => {
  const { sameCustomerByOrder, useLeftover } = await import('../src/merchant-api/slip-transfers.js');
  const paid = { customer_name: 'นราวดี สีพล', metadata: { senderAccountNumber: '5577189631' } };
  it('same customer by name (spaces / case ignored) or by full sender account', () => {
    assert.equal(sameCustomerByOrder(paid, { customer_name: 'นราวดี  สีพล', metadata: {} }), true);
    assert.equal(sameCustomerByOrder(paid, { customer_name: 'N. S.', metadata: { senderAccountNumber: '5577189631' } }), true);
  });
  it('another customer, a blank name ("-") or a partial account does not match', () => {
    assert.equal(sameCustomerByOrder(paid, { customer_name: 'นราวดี', metadata: {} }), false);
    assert.equal(sameCustomerByOrder({ customer_name: '-', metadata: {} }, { customer_name: '-', metadata: {} }), false);
    assert.equal(sameCustomerByOrder(paid, { customer_name: 'x', metadata: { senderAccountNumber: '9631' } }), false);
  });
  it('takes the order amount from the left-over, never more than is left', async () => {
    const t = transfer();
    const calls = [];
    const c = { query: async (sql, args) => {
      calls.push(sql);
      if (/UPDATE slip_transfers/.test(sql)) return { rows: [{ ...t, used: String(Number(t.used) + args[1]) }] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: 2 }] };
      return { rows: [] };
    } };
    const u = await useLeftover(c, t, 5, 200, 'api:coffee9');
    assert.equal(u.take, 200);
    assert.equal(Number(u.transfer.used), 700);
    await assert.rejects(useLeftover(c, t, 6, 1000.01, 'api:coffee9'), /does not cover/);
  });
});

describe('slip short of the order: the customer left-over pays the difference', async () => {
  const { coverShortfall } = await import('../src/merchant-api/slip-transfers.js');
  const setup = (left) => {
    const db = fakeDb({ slips: {} });
    db.transfers.push({ id: 1, trans_ref: 'OLD', amount: '1000.00', used: String(1000 - left), merchant_id: 58, bank_account_id: 19 });
    return db;
  };
  const order = { id: 9, amount: '500.00', merchant_id: 58, customer_name: 'นราวดี สีพล', metadata: {} };
  it('฿300 slip + ฿200 left-over = ฿500 order; the left-over goes to ฿0', async () => {
    const db = setup(200);
    const r = await coverShortfall(db.c, order, { kind: 'full', take: 300 }, 'system', { ...db.transfers[0] });
    assert.equal(r.short, 200);
    assert.equal(db.transfers[0].used, '1000');
    assert.deepEqual(db.uses.at(-1), { transfer_id: 1, payment_id: 9, amount: 200, kind: 'leftover' });
  });
  it('a left-over smaller than the difference is not used', async () => {
    const db = setup(100);
    assert.equal(await coverShortfall(db.c, order, { kind: 'full', take: 300 }, 'system', { ...db.transfers[0] }), null);
    assert.equal(db.transfers[0].used, '900');
  });
  it('nothing to cover: slip equals the order, or no left-over for this customer', async () => {
    const db = setup(200);
    assert.equal(await coverShortfall(db.c, order, { kind: 'full', take: 500 }, 'system', { ...db.transfers[0] }), null);
    assert.equal(await coverShortfall(db.c, order, { kind: 'full', take: 300 }, 'system', null), null);
  });
  it('a slip whose transfer was already used up never pulls from a left-over', async () => {
    const db = setup(200);
    assert.equal(await coverShortfall(db.c, order, { kind: 'over_used', take: 0 }, 'admin', { ...db.transfers[0] }), null);
  });
});

describe('สถานะ: the one decisive reason first', async () => {
  const { byWeight } = await import('../src/merchant-api/v1.service.js');
  it('wrong account beats transfer time and amount', () => {
    const r = byWeight(['สลิปทำรายการเมื่อ 14:10 ก่อนสร้างรายการนี้ — ใช้สลิปเก่าไม่ได้', 'ยอดเงินในสลิป ฿1,700.00 ไม่ตรงกับยอดที่ต้องชำระ ฿1,400.00', 'โอนเข้าธนาคาร SCB แต่รายการนี้ต้องโอนเข้า KTB 0170809536']);
    assert.match(r[0], /^โอนเข้าธนาคาร SCB/);
    assert.match(r[1], /^ยอดเงินในสลิป/);
  });
  it('wrong amount beats an old slip', () => {
    assert.match(byWeight(['สลิปเก่าเกิน 6 ชั่วโมง — ใช้สลิปเก่าไม่ได้', 'ยอดเงินในสลิป ฿500.00 ไม่ตรงกับยอดที่ต้องชำระ ฿1,000.00'])[0], /^ยอดเงิน/);
  });
});
