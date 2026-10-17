-- One row per bank transfer (the provider's transRef) that has paid at least one order, and how much of it is used.
-- Normally an order uses the whole transfer (left-over 0). When an admin approves an order with a slip for MORE than
-- the order, the difference stays as a left-over that one new order of exactly that amount, from the same customer,
-- shop and receiving account, may use within leftover_until (see src/merchant-api/slip-transfers.js).
CREATE TABLE slip_transfers (
  id              serial PRIMARY KEY,
  trans_ref       text NOT NULL UNIQUE,
  amount          numeric(14, 2) NOT NULL,
  used            numeric(14, 2) NOT NULL DEFAULT 0,
  merchant_id     integer REFERENCES merchants (id),
  bank_account_id integer REFERENCES bank_accounts (id),
  transfer_at     timestamptz,
  leftover_until  timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slip_transfers_used_within_amount CHECK (used >= 0 AND used <= amount)
);

-- Which orders a transfer paid, and how much each took. One transfer per order.
CREATE TABLE slip_transfer_uses (
  id          serial PRIMARY KEY,
  transfer_id integer NOT NULL REFERENCES slip_transfers (id) ON DELETE CASCADE,
  payment_id  integer NOT NULL UNIQUE REFERENCES payments (id) ON DELETE CASCADE,
  amount      numeric(14, 2) NOT NULL CHECK (amount >= 0),
  kind        text NOT NULL,
  actor       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slip_transfer_uses_transfer_idx ON slip_transfer_uses (transfer_id);

-- Refused slips keep the provider's transRef in verify_result (so a used-up transfer can close them): look-ups by it.
CREATE INDEX payment_slips_verify_trans_ref_idx ON payment_slips ((verify_result->>'transRef')) WHERE verify_result ? 'transRef';
