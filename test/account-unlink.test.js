// Removing shops from a bank account: blocked by orders still waiting for payment — unless the account is disabled.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refuseUnlinkWithPending } from '../src/shared/account-links.js';

const db = (status, pending) => ({ query: async (sql) => (/FROM bank_accounts/.test(sql) ? { rows: [{ status }] } : { rows: pending }) });

describe('refuseUnlinkWithPending', () => {
  it('active account with pending orders: refused', async () => {
    await assert.rejects(refuseUnlinkWithPending(db('active', [{ name: 'Coffee9', n: 3 }]), 8, [58]), /ยังมีออเดอร์รอชำระ/);
  });
  it('disabled account with pending orders: allowed', async () => {
    await refuseUnlinkWithPending(db('inactive', [{ name: 'Coffee9', n: 3 }]), 8, [58]);
  });
  it('active account without pending orders: allowed', async () => {
    await refuseUnlinkWithPending(db('active', []), 8, [58]);
  });
});
