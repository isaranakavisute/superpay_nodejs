-- Admin payments list (30 Oct 2026): the "customerLeftover" column looked for this shop's transfers that still have money
-- left by reading the whole slip_transfers table once per payment row (1.3–2.9 s per page of 100, CPU-bound on production).
-- Only transfers with money left are indexed, so it stays tiny. Created on production with CONCURRENTLY first (no locking);
-- here IF NOT EXISTS so the runner's transaction is a no-op there.
CREATE INDEX IF NOT EXISTS slip_transfers_leftover_idx
  ON slip_transfers (merchant_id, leftover_until)
  WHERE used > 0 AND amount > used;
