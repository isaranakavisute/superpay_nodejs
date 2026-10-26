-- POST /api/v2/payout/create (26 Oct 2026): marks payouts created through API v2. Only those get the v2 lifecycle
-- (status PENDING until admin ดำเนินการ = yes, and the payout.pending callback). v1 payouts keep NULL — unchanged.
ALTER TABLE outflows ADD COLUMN IF NOT EXISTS api_version text;
