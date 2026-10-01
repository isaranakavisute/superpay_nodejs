-- Slip images attached to payments, and the "slip already used" link.
-- Additive; payments is from 002. Images live in the database (bytea) so the
-- console needs no separate file storage; deleting a payment removes its slip.
ALTER TABLE payments ADD COLUMN slip_reused_ref text;  -- order whose credit this slip already paid

CREATE TABLE payment_slips (
  payment_id   bigint PRIMARY KEY REFERENCES payments (id) ON DELETE CASCADE,
  mime         text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data         bytea NOT NULL,
  uploaded_by  text,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
