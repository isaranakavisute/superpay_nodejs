-- EasySlip "slip_pending" (the bank is still processing the transfer): the slip is re-checked automatically
-- instead of being refused. recheck_at = when the next check is due; recheck_attempts = background checks done.
ALTER TABLE payment_slips ADD COLUMN recheck_at timestamptz;
ALTER TABLE payment_slips ADD COLUMN recheck_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX payment_slips_recheck_idx ON payment_slips (recheck_at) WHERE recheck_at IS NOT NULL;
