-- Fields the payments page reads and its actions write. Additive; table from 002.
ALTER TABLE payments
  ADD COLUMN merchant_order_id text,                       -- the shop's own order id
  ADD COLUMN slip_received_at  timestamptz,                -- customer sent a slip (pending → "รอตรวจสอบ")
  ADD COLUMN review_note       text,                       -- reject reason / operator note
  ADD COLUMN completed_at      timestamptz,                -- approved / rejected / refunded at
  ADD COLUMN refunded_amount   numeric(14, 2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0);
