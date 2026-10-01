-- Balance set by hand when an account's counters were reset (e.g. the float a
-- payout account starts with). Card balance = this + approved in − approved out
-- since counters_reset_at. Additive; table from 002.
ALTER TABLE bank_accounts ADD COLUMN balance_at_reset numeric(14, 2) NOT NULL DEFAULT 0;
