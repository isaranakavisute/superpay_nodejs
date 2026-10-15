-- Webhook delivery alerts (แจ้งเตือน Telegram): every POST to a shop's webhook — payments and payouts,
-- first attempt and retries — is reported. 'payout.callback' becomes the broader 'webhook.delivery'.
-- merchant_id scopes a bot to one shop and the shops under it (NULL = every shop).
UPDATE alert_channels SET events = array_replace(events, 'payout.callback', 'webhook.delivery') WHERE 'payout.callback' = ANY (events);
ALTER TABLE alert_channels ADD COLUMN merchant_id integer REFERENCES merchants (id);
