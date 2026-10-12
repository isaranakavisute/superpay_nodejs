-- ประชาสัมพันธ์: scheduled messages @OptionPaySupportBot posts to every group it is in.
-- Telegram cannot list a bot's groups, so the bot records them as it is added/removed (my_chat_member).
CREATE TABLE telegram_bot_chats (
  bot        text NOT NULL,                 -- 'support'
  chat_id    text NOT NULL,
  title      text,
  type       text,
  status     text NOT NULL,                 -- member | administrator | left | kicked
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot, chat_id)
);

CREATE TABLE announcements (
  id             serial PRIMARY KEY,
  title          text NOT NULL,
  message        text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('times', 'interval')),
  times          text[] NOT NULL DEFAULT '{}',     -- 'times': Bangkok hourly slots, e.g. {08:00,14:00}
  interval_seconds integer CHECK (interval_seconds BETWEEN 10 AND 604800),   -- 'interval': seconds / minutes / hours (min 10 s, max 7 days)
  start_at       timestamptz,                      -- 'interval': first post; then every interval_seconds
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);

-- One row per (announcement, time slot): claimed before sending, so a slot is posted once.
CREATE TABLE announcement_runs (
  id              bigserial PRIMARY KEY,
  announcement_id integer NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  slot_at         timestamptz NOT NULL,
  manual          boolean NOT NULL DEFAULT false,
  sent            integer NOT NULL DEFAULT 0,
  failed          integer NOT NULL DEFAULT 0,
  detail          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, slot_at)
);
