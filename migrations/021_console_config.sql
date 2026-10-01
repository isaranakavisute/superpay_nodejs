-- Structured console configuration (settings page), one jsonb document per
-- section, plus small binary assets (logo, favicon, alert sounds). Own tables.
CREATE TABLE console_config (
  section    text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE console_assets (
  id         text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('logo', 'favicon', 'sound')),
  name       text NOT NULL,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX console_assets_kind_idx ON console_assets (kind, created_at);
