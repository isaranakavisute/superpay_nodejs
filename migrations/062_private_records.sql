-- Private test records (18 Oct 2026, requested): rows listed here are shown in the admin console ONLY to their owner
-- (console account user_password.id) and never in the merchant portal lists. Used for the my-shop callback-test data.
CREATE TABLE IF NOT EXISTS private_records (
  kind       text        NOT NULL,           -- payment (ref) · outflow (ref) · account (id) · webhook_endpoint (id) · audit (id) · api_log (id) · credit (id)
  key        text        NOT NULL,
  owner_id   integer     NOT NULL,           -- user_password.id that may see it
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
