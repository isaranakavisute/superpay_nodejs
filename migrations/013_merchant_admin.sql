-- What the merchants page manages. New tables + additive columns on 002/004 tables.
-- API keys and webhook secrets are stored only as SHA-256 hashes plus a short
-- prefix for display; the full value is shown once, when created.

CREATE TABLE merchant_api_keys (
  id            serial PRIMARY KEY,
  merchant_id   integer NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  label         text NOT NULL,
  key_prefix    text NOT NULL,           -- e.g. sk_live_3f9a…
  key_hash      text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at  timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Hand-made balance corrections; a shop's balance includes their sum.
CREATE TABLE merchant_credit_adjustments (
  id           bigserial PRIMARY KEY,
  merchant_id  integer NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  amount       numeric(14, 2) NOT NULL CHECK (amount <> 0),   -- + adds credit, − removes it
  reason       text NOT NULL,
  balance_after numeric(14, 2) NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_portal_users (
  id           serial PRIMARY KEY,
  merchant_id  integer NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  username     text NOT NULL UNIQUE,
  full_name    text NOT NULL,
  tier         text NOT NULL DEFAULT 'staff' CHECK (tier IN ('owner', 'staff', 'viewer')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhook_endpoints
  ADD COLUMN secret_prefix text,
  ADD COLUMN secret_hash   text,
  ADD COLUMN rotated_at    timestamptz;

ALTER TABLE merchants
  ADD COLUMN contact_email text,
  ADD COLUMN contact_phone text;
