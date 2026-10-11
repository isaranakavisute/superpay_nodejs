-- Merchant Portal → ตั้งค่า can show a user's secret key and their latest login API key
-- in full after re-entering their login + password. Stored encrypted (AES-GCM, shared/secret-box);
-- the sha256 columns stay the lookup. Keys created before this have no copy and can't be revealed.
ALTER TABLE merchant_portal_users ADD COLUMN secret_key_sealed text;
ALTER TABLE merchant_api_keys ADD COLUMN key_sealed text;
