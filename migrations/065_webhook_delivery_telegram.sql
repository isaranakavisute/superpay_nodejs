-- What happened to the Telegram alert of each callback (แจ้งเตือน Telegram of the shop): how many groups got it and when.
-- NULL = the event is not alerted for this shop. Shown on the demo page's callback log (optionpay.co/demo).
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS telegram_sent integer, ADD COLUMN IF NOT EXISTS telegram_at timestamptz;
-- The exact request body that was POSTed (jsonb payload may reorder keys): the logged curl is byte-for-byte the real one.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS body text;
