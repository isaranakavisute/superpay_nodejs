-- Per shop-user secret key for POST /api/v1/auth/login (replaces email/username +
-- password on the API; the portal website still signs in with the password).
-- Only the sha256 is stored; the key is shown to the user once. Own table (022).
ALTER TABLE merchant_portal_users
  ADD COLUMN secret_key_hash text,
  ADD COLUMN secret_key_prefix text,
  ADD COLUMN secret_key_created_at timestamptz,
  ADD COLUMN secret_key_last_used_at timestamptz;
CREATE UNIQUE INDEX merchant_portal_users_secret_key_uniq ON merchant_portal_users (secret_key_hash) WHERE secret_key_hash IS NOT NULL;
