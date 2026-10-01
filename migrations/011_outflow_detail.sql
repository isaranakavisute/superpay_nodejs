-- Outflows as the console files them: the original's category set, where the
-- row came from, a free-text description, an account that may be chosen only
-- at approval time, and slip images. Own table from 002; additive otherwise.
ALTER TABLE outflows DROP CONSTRAINT outflows_category_check;
UPDATE outflows SET category = CASE category
  WHEN 'withdraw' THEN 'other' WHEN 'settlement' THEN 'transfer' ELSE category END;
ALTER TABLE outflows ADD CONSTRAINT outflows_category_check
  CHECK (category IN ('refund', 'fee', 'expense', 'transfer', 'other', 'auto', 'commission'));

ALTER TABLE outflows
  ALTER COLUMN bank_account_id DROP NOT NULL,              -- pending payouts get their account at approval
  ADD COLUMN source       text NOT NULL DEFAULT 'manual', -- manual | withdrawal | email | payout_api
  ADD COLUMN description  text,
  ADD COLUMN review_note  text,
  ADD COLUMN completed_at timestamptz;

CREATE TABLE outflow_slips (
  outflow_id   bigint PRIMARY KEY REFERENCES outflows (id) ON DELETE CASCADE,
  mime         text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data         bytea NOT NULL,
  uploaded_by  text,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
