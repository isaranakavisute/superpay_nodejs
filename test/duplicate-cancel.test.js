// 23:00 rule: a same-customer, same-amount order made after the earlier one was paid, with no payment of its own.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_REASON, last2300, noOwnPayment } from '../src/jobs/duplicate-cancel.js';

describe('last2300 (Asia/Bangkok)', () => {
  it('23:00:30 Bangkok on 17 Oct → that 23:00, day 2026-10-17', () => {
    const r = last2300(Date.parse('2026-10-17T16:00:30Z'));
    assert.equal(r.at.toISOString(), '2026-10-17T16:00:00.000Z');
    assert.equal(r.day, '2026-10-17');
    assert.equal(r.dayStart.toISOString(), '2026-10-16T17:00:00.000Z');
  });
  it('22:59 Bangkok → still the previous day\'s 23:00', () => {
    assert.equal(last2300(Date.parse('2026-10-17T15:59:00Z')).day, '2026-10-16');
  });
});

describe('noOwnPayment', () => {
  const o2 = { created_at: '2026-10-17T08:43:43Z', slip_reused_ref: null };
  const manual = { created_at: '2026-10-17T07:39:21Z', completed_at: '2026-10-17T08:06:47Z', transRef: null };   // TXN174231
  it('no slip at all → no payment of its own', () => assert.equal(noOwnPayment(o2, null, manual), true));
  it('order#1 approved by hand: a transfer between its creation and approval is order#1\'s money (TXN174469)', () => {
    assert.equal(noOwnPayment(o2, { verify_result: { decision: 'invalid', date: '2026-10-17T14:39:50+07:00' } }, manual), true);
  });
  it('the same bank ref as order#1 → order#1\'s money', () => {
    assert.equal(noOwnPayment(o2, { verify_result: { decision: 'invalid', transRef: 'A1' } }, { transRef: 'A1' }), true);
  });
  it('a DIFFERENT transfer than order#1\'s (TXN174147: paid into the old SCB account) → may be payment#2, left alone', () => {
    assert.equal(noOwnPayment(o2, { verify_result: { decision: 'invalid', transRef: 'B2', date: '2026-10-17T13:58:00+07:00' } }, { transRef: 'A1' }), false);
  });
  it('slip refused as already used (its money paid some order) → no payment of its own', () => {
    assert.equal(noOwnPayment(o2, { verify_result: { decision: 'invalid', message: 'สลิปนี้ถูกใช้กับรายการอื่นแล้ว — ใช้ซ้ำไม่ได้' } }, { transRef: 'A1' }), true);
  });
  it('slip still being re-checked, or waiting for an admin → left alone', () => {
    assert.equal(noOwnPayment(o2, { recheck_at: new Date(), verify_result: { decision: 'review' } }, manual), false);
    assert.equal(noOwnPayment(o2, { verify_result: { decision: 'review' } }, manual), false);
  });
  it('reason names order#1', () => assert.match(DUPLICATE_REASON('TXN174231'), /^ซ้ำกับ TXN174231 ที่ชำระแล้ว/));
});
