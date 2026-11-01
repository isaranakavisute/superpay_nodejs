-- Slip images as files, step 2 (2 Nov 2026, after one day of monitoring step 1): the in-database copy of a slip image
-- becomes optional, so it can be removed once the image is safely in its file (scripts/slips-db-copies-clear.js).
-- Readers already take the file first (src/shared/slip-store.js); a row without either has no image, as before.
SET lock_timeout = '10s';
ALTER TABLE payment_slips ALTER COLUMN data DROP NOT NULL;
ALTER TABLE outflow_slips ALTER COLUMN data DROP NOT NULL;
