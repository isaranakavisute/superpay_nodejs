-- Editable channel settings for the channels page. Own table (004).
-- config  = non-secret settings (JSON); secrets_enc = { field: sealed value }
-- (AES-256-GCM via src/shared/secret-box.js). Types follow the console tabs.
ALTER TABLE channels DROP CONSTRAINT channels_channel_type_check;
UPDATE channels SET channel_type = CASE channel_type WHEN 'slip' THEN 'telegram' WHEN 'webhook' THEN 'sms' ELSE channel_type END;
ALTER TABLE channels ADD CONSTRAINT channels_channel_type_check
  CHECK (channel_type IN ('telegram', 'line', 'facebook', 'email', 'sms'));

ALTER TABLE channels
  ADD COLUMN enabled         boolean NOT NULL DEFAULT true,
  ADD COLUMN config          jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN secrets_enc     jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN account_ids     integer[] NOT NULL DEFAULT '{}',   -- receiving accounts this bot handles
  ADD COLUMN endpoint_ids    integer[] NOT NULL DEFAULT '{}',   -- webhook endpoints to notify on approve
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();
