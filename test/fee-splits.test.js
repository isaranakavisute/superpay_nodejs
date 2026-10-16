// ค่าคอม along a tree: each level gets (fee at the rate of the shop just below it) − (fee at its own rate), and the
// shares sum to what the selling shop pays. Example from the admin manual: ฿10,000 at a 3% shop under 3 levels.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitFee } from '../src/merchants/tree.js';

const shop = (id, pct) => ({ id, fee_percent: pct, fee_flat: 0, out_fee_percent: 0.6, out_fee_flat: 0 });
const chain = [shop(1, 1.5), shop(2, 2.0), shop(3, 2.5), shop(4, 3.0)];

describe('fee shares along the chain', () => {
  const s = splitFee(chain, 10000, 'in');
  it('platform gets the root rate, every level the gap to the shop below', () => {
    assert.deepEqual(s.map((x) => [x.merchantId, x.amount]), [[null, 150], [1, 50], [2, 50], [3, 50]]);
  });
  it('shares add up to what the selling shop pays (3% = 300)', () => {
    assert.equal(s.reduce((t, x) => t + x.amount, 0), 300);
  });
  it('each share keeps the two fees and rates it is the difference of', () => {
    const lvl1 = s.find((x) => x.merchantId === 1);
    assert.deepEqual(lvl1.below, { fee: 200, pct: 2, flat: 0, merchantId: 2 });
    assert.deepEqual(lvl1.own, { fee: 150, pct: 1.5, flat: 0 });
    assert.equal(lvl1.below.fee - lvl1.own.fee, lvl1.amount);
  });
  it('a level with the same rate as the shop below earns nothing (no share row)', () => {
    const same = splitFee([shop(1, 1.6), shop(58, 1.6)], 500, 'in');
    assert.deepEqual(same.map((x) => [x.merchantId, x.amount]), [[null, 8]]);
  });
});
