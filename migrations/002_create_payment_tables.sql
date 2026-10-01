-- Payment-console tables for the SuperPay admin dashboard.
--
-- Additive only: creates five new tables and touches nothing that already
-- exists (products, users, user_password). Plain CREATE TABLE (no IF NOT
-- EXISTS) so a name clash fails loudly instead of adopting a foreign table.
--
-- Money is numeric(14,2) and returned to JS as a string (see src/db/pool.js).
-- Timestamps are timestamptz; "days" are computed in Asia/Bangkok at query time.

CREATE TABLE banks (
  code   text PRIMARY KEY,
  name   text NOT NULL,
  color  text NOT NULL
);

CREATE TABLE merchants (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  slug         text NOT NULL UNIQUE,
  fee_percent  numeric(5, 2)  NOT NULL DEFAULT 0 CHECK (fee_percent >= 0),
  fee_flat     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (fee_flat >= 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_accounts (
  id            serial PRIMARY KEY,
  label         text NOT NULL,
  bank_code     text NOT NULL REFERENCES banks (code),
  account_type  text NOT NULL CHECK (account_type IN ('receive', 'send', 'both')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id               bigserial PRIMARY KEY,
  ref              text NOT NULL UNIQUE,
  merchant_id      integer REFERENCES merchants (id),  -- null = house payment
  customer_name    text NOT NULL,
  payer_bank_code  text NOT NULL REFERENCES banks (code),
  bank_account_id  integer NOT NULL REFERENCES bank_accounts (id),
  amount           numeric(14, 2) NOT NULL CHECK (amount > 0),
  fee              numeric(14, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  currency         text NOT NULL DEFAULT 'THB',
  status           text NOT NULL
                   CHECK (status IN ('pending', 'approved', 'rejected', 'refunded', 'expired')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_created_at_idx ON payments (created_at DESC);
CREATE INDEX payments_status_idx ON payments (status);
CREATE INDEX payments_merchant_id_idx ON payments (merchant_id);

CREATE TABLE outflows (
  id                  bigserial PRIMARY KEY,
  ref                 text NOT NULL UNIQUE,
  merchant_id         integer REFERENCES merchants (id),
  category            text NOT NULL
                      CHECK (category IN ('withdraw', 'settlement', 'expense', 'refund')),
  bank_account_id     integer NOT NULL REFERENCES bank_accounts (id),  -- account debited
  receiver_name       text NOT NULL,
  receiver_bank_code  text NOT NULL REFERENCES banks (code),
  receiver_account    text NOT NULL,
  amount              numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency            text NOT NULL DEFAULT 'THB',
  status              text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outflows_created_at_idx ON outflows (created_at DESC);
CREATE INDEX outflows_status_idx ON outflows (status);
CREATE INDEX outflows_merchant_id_idx ON outflows (merchant_id);
