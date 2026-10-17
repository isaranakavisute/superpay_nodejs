-- The midnight cancellation considers only what was created from this moment on (agreed 17 Oct 2026): older
-- unfinished payments / payouts are left as they are (no rejection, no webhook).
ALTER TABLE daily_jobs ADD COLUMN since timestamptz;
UPDATE daily_jobs SET since = now() WHERE job = 'midnight_cancel';
