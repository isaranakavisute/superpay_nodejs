-- Every slip ever attached to an order, kept (user, 2 Nov 2026 — TXN222101: an admin replaced the verified slip of an
-- approved order with another customer's slip, and the order kept no record of the slip that had approved it).
-- payment_slips stays the order's ONE official slip; this table is the history: the official ones, the evidence
-- attached to finished orders, and the attempts that were refused (their images are kept as files too).
SET lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS payment_slip_history (
  id           bigserial PRIMARY KEY,
  payment_id   bigint NOT NULL REFERENCES payments (id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  uploaded_by  text,
  -- checked  = went through the full automatic check (shop API, checkout page, admin on an open order)
  -- evidence = attached to a finished order after the bank check matched it (does not change the order)
  -- refused  = attached to a finished order and refused (locked / does not belong to this order); the order kept its slip
  -- earlier  = the order's slip from before this history existed (filled once below)
  outcome      text NOT NULL CHECK (outcome IN ('checked', 'evidence', 'refused', 'earlier')),
  reason       text,
  mime         text,
  file_path    text,
  image_sha256 text,
  qr_payload   text,
  slip_amount  numeric(14,2),
  slip_date    timestamptz,
  slip_ref     text,
  slip_sender  text
);
CREATE INDEX IF NOT EXISTS payment_slip_history_payment ON payment_slip_history (payment_id, uploaded_at);

-- The slips orders have now, as their first history entry.
INSERT INTO payment_slip_history (payment_id, uploaded_at, uploaded_by, outcome, reason, mime, file_path, image_sha256, qr_payload, slip_amount, slip_date, slip_ref)
SELECT s.payment_id, s.uploaded_at, s.uploaded_by, 'earlier', s.verify_result->>'message', s.mime, s.file_path, s.image_sha256, s.qr_payload,
       CASE WHEN (s.verify_result->>'amount') ~ '^[0-9]+(\.[0-9]+)?$' THEN (s.verify_result->>'amount')::numeric END,
       CASE WHEN s.verify_result->>'date' ~ '^\d{4}-\d{2}-\d{2}' THEN (s.verify_result->>'date')::timestamptz END,
       coalesce(s.trans_ref, s.verify_result->>'transRef')
  FROM payment_slips s
 WHERE NOT EXISTS (SELECT 1 FROM payment_slip_history h WHERE h.payment_id = s.payment_id);
