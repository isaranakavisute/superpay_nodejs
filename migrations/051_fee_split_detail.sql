SET lock_timeout = '3s';
-- ค่าคอม must be explainable after rates change: each share keeps the two fees (and rates) it is the difference of.
-- share = fee at the rate of the shop just below this one on the chain (below_*) − fee at this shop's own rate (own_*).
-- The platform's share (merchant_id NULL) has only own_*. Shares written before this keep NULLs (recomputed on display).
ALTER TABLE fee_splits
  ADD COLUMN below_merchant_id integer REFERENCES merchants (id) ON DELETE SET NULL,
  ADD COLUMN below_fee   numeric(14, 2),
  ADD COLUMN below_pct   numeric(6, 3),
  ADD COLUMN below_flat  numeric(14, 2),
  ADD COLUMN own_fee     numeric(14, 2),
  ADD COLUMN own_pct     numeric(6, 3),
  ADD COLUMN own_flat    numeric(14, 2);
CREATE INDEX IF NOT EXISTS fee_splits_merchant_idx ON fee_splits (merchant_id) WHERE merchant_id IS NOT NULL;
