-- Every X-API-Key request is signed: X-Timestamp + X-Signature = HMAC-SHA256(secret, "ts.METHOD.path.body").
-- Keys of a shop user are signed with that user's secret key; shop-level keys get their own
-- signing secret (ss_live_…), stored sealed (shared/secret-box) and shown once. Own table (013/022).
ALTER TABLE merchant_api_keys ADD COLUMN signing_secret_sealed text;

-- Signatures already accepted (replay protection); rows older than the 5-minute window are purged.
CREATE TABLE api_request_signatures (
  signature   text PRIMARY KEY,
  merchant_id integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_request_signatures_created_idx ON api_request_signatures (created_at);
