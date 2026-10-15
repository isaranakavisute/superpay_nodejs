-- Every merchant API (/api/v1) call: who, what, result — kept 90 days. Never keys, secrets, signatures or bodies.
CREATE TABLE api_request_logs (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  merchant_id   integer,               -- the shop the call acted for (the sub-merchant with X-Sub-Merchant)
  key_merchant_id integer,             -- the shop that owns the API key (differs only with X-Sub-Merchant)
  key_prefix    text,                  -- first characters of X-API-Key only, e.g. ak_live_BJ6Q…
  key_user      text,                  -- portal user the key belongs to (null = shop-level key)
  method        text NOT NULL,
  path          text NOT NULL,
  query         text,
  status        smallint NOT NULL,
  error_code    text,
  duration_ms   integer NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX api_request_logs_created_idx ON api_request_logs (created_at DESC);
CREATE INDEX api_request_logs_merchant_idx ON api_request_logs (merchant_id, created_at DESC);
