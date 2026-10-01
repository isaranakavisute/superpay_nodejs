-- Console 2FA (TOTP) on the console's own profile table (004).
-- totp_secret is sealed with secret-box (AES-256-GCM); totp_pending holds a
-- not-yet-confirmed secret during setup; totp_last_step blocks code replay.
ALTER TABLE console_user_profiles
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_pending text,
  ADD COLUMN totp_enabled_at timestamptz,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN password_changed_at timestamptz;
