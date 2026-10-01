-- Console users can be soft-deleted (restorable). Own table (004).
ALTER TABLE console_user_profiles DROP CONSTRAINT console_user_profiles_status_check;
ALTER TABLE console_user_profiles ADD CONSTRAINT console_user_profiles_status_check
  CHECK (status IN ('active', 'inactive', 'locked', 'deleted'));
ALTER TABLE console_user_profiles ADD COLUMN deleted_at timestamptz;
