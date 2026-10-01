-- Remaining admin-console tables (one per console page that had no data source).
--
-- Additive only: new tables, plus two nullable columns on tables created by
-- 002. Nothing pre-existing (products, users, user_password) is altered;
-- console_user_profiles references user_password.id but does not change it.

-- Who reviewed a payment (payments page "ตรวจสอบโดย").
ALTER TABLE payments ADD COLUMN reviewed_by text;
-- Merchant KYC state (merchants page).
ALTER TABLE merchants ADD COLUMN kyc_status text NOT NULL DEFAULT 'pending'
  CHECK (kyc_status IN ('pending', 'verified', 'rejected'));

-- Console roles and the per-account profile on top of user_password.
CREATE TABLE console_roles (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}',
  sort_order   integer NOT NULL DEFAULT 0
);

CREATE TABLE console_user_profiles (
  user_password_id  integer PRIMARY KEY REFERENCES user_password (id),
  full_name         text NOT NULL,
  email             text,
  phone             text,
  role_code         text NOT NULL REFERENCES console_roles (code),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'locked')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE console_logins (
  id                bigserial PRIMARY KEY,
  user_password_id  integer NOT NULL REFERENCES user_password (id),
  ip                text,
  logged_in_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX console_logins_user_idx ON console_logins (user_password_id, logged_in_at DESC);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_ref  text,
  detail      text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);

-- Merchant withdrawal requests; an approved request is paid out as an outflow.
CREATE TABLE withdrawal_requests (
  id                 bigserial PRIMARY KEY,
  ref                text NOT NULL UNIQUE,
  merchant_id        integer NOT NULL REFERENCES merchants (id),
  receiver_name      text NOT NULL,
  receiver_bank_code text NOT NULL REFERENCES banks (code),
  receiver_account   text NOT NULL,
  amount             numeric(14, 2) NOT NULL CHECK (amount > 0),
  note               text,
  status             text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by        text,
  outflow_id         bigint REFERENCES outflows (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawal_requests_created_at_idx ON withdrawal_requests (created_at DESC);

-- Where payment evidence arrives from (slip checker, SMS, bank e-mail, API).
CREATE TABLE channels (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  channel_type   text NOT NULL CHECK (channel_type IN ('slip', 'telegram', 'line', 'email', 'webhook')),
  provider       text NOT NULL,
  account        text NOT NULL,  -- bot handle / OA / mailbox / endpoint, masked
  events_today   integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
  last_event_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Raw incoming notifications, matched (or not) to payments.
CREATE TABLE inbound_events (
  id            bigserial PRIMARY KEY,
  channel_id    integer NOT NULL REFERENCES channels (id),
  sender        text NOT NULL,
  amount        numeric(14, 2),
  summary       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('new', 'matched', 'rejected', 'manual')),
  payment_ref   text,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_events_received_at_idx ON inbound_events (received_at DESC);

-- Phones running the SMS/notification forwarder app.
CREATE TABLE forwarder_devices (
  id               serial PRIMARY KEY,
  name             text NOT NULL,
  device_uid       text NOT NULL UNIQUE,
  platform         text NOT NULL CHECK (platform IN ('android', 'ios')),
  phone_masked     text NOT NULL,
  bank_account_id  integer REFERENCES bank_accounts (id),
  app_version      text NOT NULL,
  battery_pct      integer CHECK (battery_pct BETWEEN 0 AND 100),
  status           text NOT NULL CHECK (status IN ('online', 'offline', 'disabled')),
  last_seen_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id           serial PRIMARY KEY,
  merchant_id  integer NOT NULL REFERENCES merchants (id),
  url          text NOT NULL,
  events       text[] NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            bigserial PRIMARY KEY,
  endpoint_id   integer NOT NULL REFERENCES webhook_endpoints (id),
  event         text NOT NULL,
  payment_ref   text,
  status_code   integer,
  attempts      integer NOT NULL DEFAULT 1,
  response_ms   integer,
  error         text,  -- why it failed / what to do
  delivered_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_delivered_at_idx ON webhook_deliveries (delivered_at DESC);

-- Telegram alert targets.
CREATE TABLE alert_channels (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  chat_masked    text NOT NULL,
  events         text[] NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_sent_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- System settings (key/value, grouped).
CREATE TABLE console_settings (
  key          text PRIMARY KEY,
  grp          text NOT NULL,
  label        text NOT NULL,
  value        text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- P2P: a merchant withdrawal paid by matching it against an incoming deposit.
CREATE TABLE p2p_matches (
  id            bigserial PRIMARY KEY,
  ref           text NOT NULL UNIQUE,
  withdrawal_ref text NOT NULL,
  payment_ref   text NOT NULL,
  amount        numeric(14, 2) NOT NULL CHECK (amount > 0),
  receiver_name text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'matched', 'released', 'cancelled')),
  matched_at    timestamptz NOT NULL DEFAULT now()
);

-- One bank transfer credited to two orders.
CREATE TABLE double_credits (
  id               bigserial PRIMARY KEY,
  merchant_id      integer REFERENCES merchants (id),
  credited_ref     text NOT NULL,   -- order that got the money a second time
  slip_holder_ref  text NOT NULL,   -- order the slip actually belongs to
  amount           numeric(14, 2) NOT NULL CHECK (amount > 0),
  manual_approved  boolean NOT NULL DEFAULT false,
  reason           text NOT NULL,
  status           text NOT NULL CHECK (status IN ('open', 'resolved')),
  resolution       text,
  resolved_by      text,
  detected_at      timestamptz NOT NULL DEFAULT now()
);
