// Slip bot: a TXN number sent with the photo (caption) or printed anywhere in the image is used directly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { txnRefsIn } from '../src/telegram/slip-bot.service.js';

describe('TXN numbers in a caption / image text', () => {
  it('finds the TXN wherever it is in the text', () => {
    assert.deepEqual(txnRefsIn('TXN172919'), ['TXN172919']);
    assert.deepEqual(txnRefsIn('โอนแล้วครับ\nรายการ TXN172919\nขอบคุณ'), ['TXN172919']);
    assert.deepEqual(txnRefsIn('Bangkok Bank ... 500.00 THB ... txn 172919'), ['TXN172919']);
  });
  it('tolerates separators and an O read as zero', () => {
    assert.deepEqual(txnRefsIn('TXN-172919'), ['TXN172919']);
    assert.deepEqual(txnRefsIn('TXN: 172919'), ['TXN172919']);
    assert.deepEqual(txnRefsIn('TXN17291O'), ['TXN172910']);
  });
  it('returns every distinct TXN, and nothing when there is none', () => {
    assert.deepEqual(txnRefsIn('TXN172919 TXN172920 TXN172919'), ['TXN172919', 'TXN172920']);
    assert.deepEqual(txnRefsIn('โอนแล้วนะ'), []);
    assert.deepEqual(txnRefsIn(''), []);
    assert.deepEqual(txnRefsIn(undefined), []);
  });
});

describe('caption that names an order skips "ตรวจไหม?"', async () => {
  const { captionNamesOrder } = await import('../src/telegram/slip-bot.service.js');
  it('a TXN anywhere in the caption counts', async () => {
    assert.equal(await captionNamesOrder('TXN172919'), true);
    assert.equal(await captionNamesOrder('โอนแล้วครับ txn 172919'), true);
  });
  it('no caption or ordinary chat does not', async () => {
    assert.equal(await captionNamesOrder(null), false);
    assert.equal(await captionNamesOrder(''), false);
    assert.equal(await captionNamesOrder('โอนแล้วนะคะ'), false);
  });
});
