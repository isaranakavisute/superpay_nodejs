-- Float each merchant starts with before any payment or withdrawal, so a
-- shop's withdrawable balance = opening_balance + approved (amount - fee)
-- - approved outflows. Additive, on a table created by 002.
ALTER TABLE merchants
  ADD COLUMN opening_balance numeric(14, 2) NOT NULL DEFAULT 0;
