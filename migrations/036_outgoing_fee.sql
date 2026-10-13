-- Outgoing fee per shop (ค่าธรรมเนียมเงินออก): % + fixed, charged ON TOP of shop-initiated money out
-- (withdrawal requests, API payouts, P2P-settled withdrawals) — the receiver gets the full amount and the
-- shop balance is debited amount + fee. Admin manual outflows carry fee 0. Fixed on each row when created.
ALTER TABLE merchants
  ADD COLUMN out_fee_percent numeric(5, 2)  NOT NULL DEFAULT 0 CHECK (out_fee_percent >= 0),
  ADD COLUMN out_fee_flat    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (out_fee_flat >= 0);
ALTER TABLE outflows            ADD COLUMN fee numeric(14, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0);
ALTER TABLE withdrawal_requests ADD COLUMN fee numeric(14, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0);
