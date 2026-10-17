-- An order may now be paid by two transfers: its own slip plus the customer's left-over for the difference
-- (e.g. ฿300 slip + ฿200 left-over = ฿500 order). One row per (transfer, order) instead of one per order.
ALTER TABLE slip_transfer_uses DROP CONSTRAINT slip_transfer_uses_payment_id_key;
ALTER TABLE slip_transfer_uses ADD CONSTRAINT slip_transfer_uses_transfer_payment_key UNIQUE (transfer_id, payment_id);
CREATE INDEX slip_transfer_uses_payment_idx ON slip_transfer_uses (payment_id);
