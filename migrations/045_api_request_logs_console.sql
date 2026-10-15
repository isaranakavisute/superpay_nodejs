-- The request log also records admin actions made through the console API (writes only): source + admin name.
ALTER TABLE api_request_logs ADD COLUMN source text NOT NULL DEFAULT 'api';   -- 'api' = merchant /api/v1 · 'console' = admin action
ALTER TABLE api_request_logs ADD COLUMN actor text;                           -- the admin, for console actions
