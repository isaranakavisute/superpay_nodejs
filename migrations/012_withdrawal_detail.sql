-- Withdrawal-request fields the console shows and its actions write. Own table (004).
ALTER TABLE withdrawal_requests
  ADD COLUMN merchant_ref  text,   -- the shop's own idempotency / reference key
  ADD COLUMN reject_reason text,
  ADD COLUMN decided_at    timestamptz;
