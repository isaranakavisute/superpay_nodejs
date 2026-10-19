-- Refs created by the public demo page (optionpay.co/demo). The page's รายการเงินเข้า / รายการเงินออก lists show only these;
-- the records themselves are ordinary payments / payouts of the demo shop and appear in the admin console as usual.
CREATE TABLE IF NOT EXISTS demo_records (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('payment', 'payout')),
  ref         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref)
);
