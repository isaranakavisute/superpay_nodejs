// payout.failed callback (admin rejects a payout): same body shape as the payout.completed example sent to prismapays.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { payoutPayload } from '../src/webhooks/webhook.service.js';

const EXAMPLE_KEYS = ['event', 'ref', 'orderId', 'merchantRef', 'amount', 'status', 'failureReason', 'createdAt', 'completedAt'];
const out = (over) => ({
  ref: 'OUT40197', merchant_ref: 'WD-01a13d56-9ad2-7538-b6ed-e1186c3681ac', amount: '550.00', status: 'rejected',
  review_note: 'ยกเลิกโดยผู้ดูแลระบบ', created_at: new Date('2026-10-15T02:14:08.819Z'), completed_at: new Date('2026-10-15T06:09:44.502Z'), ...over,
});

describe('payout webhook payload', () => {
  it('rejected payout → payout.failed with the reason, keys exactly as the example', () => {
    const p = payoutPayload('payout.failed', out());
    assert.deepEqual(Object.keys(p), EXAMPLE_KEYS);
    assert.deepEqual(p, {
      event: 'payout.failed', ref: 'OUT40197',
      orderId: 'WD-01a13d56-9ad2-7538-b6ed-e1186c3681ac', merchantRef: 'WD-01a13d56-9ad2-7538-b6ed-e1186c3681ac',
      amount: '550.00', status: 'failed', failureReason: 'ยกเลิกโดยผู้ดูแลระบบ',
      createdAt: '2026-10-15T02:14:08.819Z', completedAt: '2026-10-15T06:09:44.502Z',
    });
  });
  it('approved payout → completed, no failure reason', () => {
    const p = payoutPayload('payout.completed', out({ status: 'approved', review_note: 'note', amount: 1500 }));
    assert.equal(p.status, 'completed');
    assert.equal(p.failureReason, null);
    assert.equal(p.amount, '1500.00');
  });
  it('no merchantRef → nulls, not undefined (keys always present)', () => {
    const p = payoutPayload('payout.failed', out({ merchant_ref: null, completed_at: null }));
    assert.equal(p.orderId, null);
    assert.equal(p.completedAt, null);
    assert.ok(JSON.stringify(p).includes('"orderId":null'));
  });
  it('admin ดำเนินการ → yes → payout.completed: status completed, completedAt = transfer time', () => {
    const p = payoutPayload('payout.completed', out({ status: 'approved', review_note: null, completed_at: new Date('2026-10-15T09:29:45.872Z'), admin_done_at: new Date('2026-10-15T09:40:11.245Z') }));
    assert.deepEqual(Object.keys(p), EXAMPLE_KEYS);
    assert.equal(p.event, 'payout.completed');
    assert.equal(p.status, 'completed');
    assert.equal(p.failureReason, null);
    assert.equal(p.completedAt, '2026-10-15T09:40:11.245Z');
  });
});
