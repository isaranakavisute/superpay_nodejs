-- POST /api/v2/payment/create (20–21 Oct 2026): where the checkout page sends the customer after paying.
-- NULL for every v1 order (and v2 orders sent without one) → the checkout page behaves exactly as before.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS return_url text;
