-- ตั้งค่าการส่ง Webhook: per endpoint and per event, post it to the shop (events) and/or alert Telegram
-- (alert_events). Both default to off. Deliveries can also be about a withdrawal request.
ALTER TABLE webhook_endpoints ADD COLUMN alert_events text[] NOT NULL DEFAULT '{}';
ALTER TABLE webhook_endpoints ALTER COLUMN events SET DEFAULT '{}';
ALTER TABLE webhook_deliveries ADD COLUMN withdrawal_ref text;
CREATE INDEX webhook_deliveries_withdrawal_ref_idx ON webhook_deliveries (withdrawal_ref) WHERE withdrawal_ref IS NOT NULL;
-- Every send to an endpoint is currently alerted: keep that for what each endpoint sends today.
UPDATE webhook_endpoints SET alert_events = events WHERE status = 'active' AND events && ARRAY['payout.completed', 'payout.failed'];
