// Carry-over must find the customer's earlier order even when many newer orders sit on the same shared account.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { carryOverFrom } from '../src/merchant-api/slip-carry-over.js';

const transfer = new Date(Date.now() - 2 * 3_600_000);  // 2 h ago
const slip = { date: transfer.toISOString(), provider: 'easyslip',
  raw: { sender: { account: { name: { th: 'น.ส.นฤมล ล', en: 'MISSNaruemon L' }, bank: { account: 'XXX-X-XX141-2' } } } } };
const order = { id: 999, merchant_id: 58, bank_account_id: 19 };
const other = (i) => ({ id: i, ref: `TXN${i}`, amount: '500.00', status: 'expired', customer_name: `ลูกค้า ${i}`, payer_account_masked: '···9999',
  created_at: new Date(transfer.getTime() + 5 * 60_000 - i * 1000) });
const hers = { id: 771, ref: 'TXN173771', amount: '1100.00', status: 'expired', customer_name: 'นฤมล ลืมสวัสดิ์', payer_account_masked: '···1412',
  created_at: new Date(transfer.getTime() - 5 * 60_000) };

describe('carry-over on a busy shared account', () => {
  it('finds the customer even when her order is #24 of 151 candidates (was missed with the old limit of 20)', async () => {
    const rows = [...Array.from({ length: 23 }, (_, i) => other(i + 1)), hers, ...Array.from({ length: 127 }, (_, i) => other(100 + i))];
    let sql = '';
    const c = { query: async (q) => { sql = q; return { rows }; } };
    const found = await carryOverFrom(c, order, slip);
    assert.equal(found?.ref, 'TXN173771');
    assert.doesNotMatch(sql, /LIMIT 20\b/);
  });
  it('returns null when no earlier order belongs to the slip payer', async () => {
    const c = { query: async () => ({ rows: Array.from({ length: 40 }, (_, i) => other(i + 1)) }) };
    assert.equal(await carryOverFrom(c, order, slip), null);
  });
});

describe('same customer by bank account when the slip shows only an English name', async () => {
  const { sameCustomer } = await import('../src/merchant-api/slip-carry-over.js');
  const order = { customer_name: 'นราวดี สีพล', payer_account_masked: '···9631', metadata: { senderAccountNumber: '5577189631' } };
  it('masked slip account matches the full account digit by digit (TXN173893 case)', () => {
    assert.equal(sameCustomer({ senderNames: ['MS NARAWADEE S'], senderAccount: '557-7-xxx631' }, order), true);
  });
  it('other bank masking layouts match too', () => {
    assert.equal(sameCustomer({ senderNames: ['MISS X'], senderAccount: 'XXX-X-XX963-1' }, order), true);
  });
  it('a different account does not match', () => {
    assert.equal(sameCustomer({ senderNames: ['MS NARAWADEE S'], senderAccount: '557-7-xxx632' }, order), false);
    assert.equal(sameCustomer({ senderNames: ['MS NARAWADEE S'], senderAccount: '123-4-xxx631' }, order), false);
  });
  it('too few visible digits is not enough', () => {
    assert.equal(sameCustomer({ senderNames: ['MS NARAWADEE S'], senderAccount: 'xxx-x-xxx631' }, order), false);
  });
  it('without the full account it falls back to the last-4 rule as before', () => {
    assert.equal(sameCustomer({ senderNames: ['MS X'], senderAccount: '557-7-xxx631' }, { ...order, metadata: {} }), false);
  });
});

describe('explaining a refusal: the earlier order may be on another account of the shop', () => {
  it('anyAccount drops the receiving-account filter (explanation only)', async () => {
    let args = null;
    const c = { query: async (_q, a) => { args = a; return { rows: [hers] }; } };
    const found = await carryOverFrom(c, { ...order, bank_account_id: 20 }, slip, { anyAccount: true });
    assert.equal(found?.ref, 'TXN173771');
    assert.equal(args[1], null);
  });
  it('without it, only the order\'s own account is searched (accepting a slip)', async () => {
    let args = null;
    const c = { query: async (_q, a) => { args = a; return { rows: [] }; } };
    await carryOverFrom(c, { ...order, bank_account_id: 20 }, slip);
    assert.equal(args[1], 20);
  });
});
