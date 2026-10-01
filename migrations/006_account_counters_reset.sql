-- When an account's balance/counters were last reset (accounts page cards).
-- Balance and in/out counts are computed from approved payments/outflows
-- since this moment; NULL means "since the beginning". Additive; table from 002.
ALTER TABLE bank_accounts ADD COLUMN counters_reset_at timestamptz;
