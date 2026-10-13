-- @OptionPayBot asks for the expected payment details before verifying a slip:
-- one open conversation per (chat, user), answered by that user's next messages; expires after 10 minutes.
CREATE TABLE telegram_slip_sessions (
  chat_id    text NOT NULL,
  user_id    text NOT NULL,
  file_id    text NOT NULL,
  mime       text NOT NULL,
  message_id bigint,                -- the slip message (replies go under it)
  step       text NOT NULL,         -- ref | amount | account | name | sender
  data       jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
