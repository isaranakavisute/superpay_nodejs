// Guards against the 14 Oct 2026 incident: satang added to orders on a shared account made round-amount slips fail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountRule } from '../src/shared/account-links.js';
import { matchSlip } from '../src/merchant-api/slip-match.js';

const client = (links) => ({ query: async () => ({ rows: [{ n: links }] }) });

describe('unique satang (amountRule)', () => {
  it('a shared account never adds satang by itself', async () => {
    const r = await amountRule(client(2), 8, { uniqueAmount: false });
    assert.equal(r.shared, true);
    assert.equal(r.unique, false);
  });
  it('an unshared account with the setting off adds none', async () => {
    assert.equal((await amountRule(client(1), 8, { uniqueAmount: false })).unique, false);
  });
  it('only the "ยอดไม่ซ้ำ" setting turns satang on', async () => {
    assert.equal((await amountRule(client(1), 8, { uniqueAmount: true })).unique, true);
    assert.equal((await amountRule(client(2), 8, { uniqueAmount: true })).unique, true);
  });
});

describe('slip amount vs order amount', () => {
  const order = (amount, requested) => ({
    amount, requested_amount: requested, created_at: '2026-10-14T10:00:00Z',
    acct_bank: 'SCB', account_no: '4182186378', account_name: 'มิดทาวน์ไลท์ จำกัด', promptpay_id: null, customer_name: '-',
  });
  const slip = (amount) => ({
    provider: 'easyslip', verified: true, amount, date: '2026-10-14T10:05:00Z',
    raw: { receiver: { bank: { short: 'SCB' }, account: { name: { th: 'บริษัท มิดทาวน์ไลท์ จ' }, bank: { account: 'xxx-x-x8637-x' } } }, sender: { account: { name: { th: 'นาย ก' } } } },
  });
  const amountCheck = (m) => m.checks.find((c) => c.check === 'AMOUNT').status;

  it('satang added, customer paid the round amount the shop asked for → passes (paidRequested)', () => {
    const m = matchSlip(slip(500), order('500.29', '500.00'));
    assert.equal(amountCheck(m), 'PASS');
    assert.equal(m.paidRequested, true);
    assert.deepEqual(m.problems, []);
  });
  it('satang added, customer paid the exact satang amount → passes', () => {
    const m = matchSlip(slip(500.29), order('500.29', '500.00'));
    assert.equal(amountCheck(m), 'PASS');
    assert.equal(m.paidRequested, false);
  });
  it('a different amount still fails', () => {
    const m = matchSlip(slip(400), order('500.29', '500.00'));
    assert.equal(amountCheck(m), 'FAIL');
    assert.equal(m.problems.length, 1);
  });
  it('orders without requested_amount (older) keep the exact-amount rule', () => {
    assert.equal(amountCheck(matchSlip(slip(500), order('500.29', null))), 'FAIL');
    assert.equal(amountCheck(matchSlip(slip(500), order('500.00', null))), 'PASS');
  });
});
