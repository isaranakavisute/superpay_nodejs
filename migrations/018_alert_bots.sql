-- Telegram alert bots, editable from the alerts page. Own table (004).
-- A bot either reuses a Telegram channel's token (bot_channel_id) or has its
-- own (bot_token_enc, AES-256-GCM via src/shared/secret-box.js).
ALTER TABLE alert_channels
  ADD COLUMN enabled         boolean NOT NULL DEFAULT true,
  ADD COLUMN bot_channel_id  integer REFERENCES channels (id) ON DELETE SET NULL,
  ADD COLUMN bot_token_enc   text,
  ADD COLUMN chat_ids        text NOT NULL DEFAULT '',
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();
