-- Details the console shows next to payments, plus the per-shop minimum
-- balance behind the dashboard's low-balance banner. Additive; all on tables
-- created by 002.
ALTER TABLE bank_accounts
  ADD COLUMN account_name text,  -- holder name shown under the bank name
  ADD COLUMN account_no   text;  -- full number, as shown to operators

ALTER TABLE payments
  ADD COLUMN payer_account_masked text,                       -- e.g. ••••••0166
  ADD COLUMN commission numeric(14, 2) NOT NULL DEFAULT 0;    -- paid out of the fee

ALTER TABLE merchants
  ADD COLUMN min_balance numeric(14, 2) NOT NULL DEFAULT 0;
