-- Which shop user a merchant API key was issued to (POST /api/v1/auth/login),
-- so the API can enforce that user's level. NULL = shop-level key (created by
-- an admin or in the portal): full access. Own table (013/022).
ALTER TABLE merchant_api_keys
  ADD COLUMN portal_user_id integer REFERENCES merchant_portal_users (id) ON DELETE CASCADE;

-- Existing login-issued keys are labelled "login:<username>".
UPDATE merchant_api_keys k
   SET portal_user_id = u.id
  FROM merchant_portal_users u
 WHERE k.source = 'login' AND u.merchant_id = k.merchant_id AND k.label = 'login:' || u.username;

CREATE INDEX merchant_api_keys_portal_user_idx ON merchant_api_keys (portal_user_id);
