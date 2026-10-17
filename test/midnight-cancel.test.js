// The midnight cancellation runs for the latest Bangkok midnight (UTC+7), whatever the server's own time zone.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lastMidnight, MIDNIGHT_REASON } from '../src/jobs/midnight-cancel.js';

describe('lastMidnight (Asia/Bangkok)', () => {
  it('00:00:30 Bangkok on 18 Oct → that midnight (17 Oct 17:00 UTC), day 2026-10-18', () => {
    const r = lastMidnight(Date.parse('2026-10-17T17:00:30Z'));
    assert.equal(r.at.toISOString(), '2026-10-17T17:00:00.000Z');
    assert.equal(r.day, '2026-10-18');
  });
  it('23:59 Bangkok on 17 Oct → still the midnight that started 17 Oct', () => {
    const r = lastMidnight(Date.parse('2026-10-17T16:59:00Z'));
    assert.equal(r.at.toISOString(), '2026-10-16T17:00:00.000Z');
    assert.equal(r.day, '2026-10-17');
  });
  it('exactly midnight counts as the new day', () => {
    assert.equal(lastMidnight(Date.parse('2026-10-17T17:00:00Z')).day, '2026-10-18');
  });
  it('uses the agreed reason text', () => {
    assert.equal(MIDNIGHT_REASON, 'ยกเลิกเนื่องจากยังไม่ได้ดำเนินการภายในเที่ยงคืน');
  });
});
