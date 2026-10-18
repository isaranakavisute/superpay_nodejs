-- Soft delete (18 Oct 2026, requested): every console "delete" keeps the row and records who deleted it, when and why.
-- Deleted rows are hidden from the console lists and shown on รายการที่ลบแล้ว (/deleted), where Super Admin can restore them.
-- Additive only: new nullable columns, nothing dropped or rewritten.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments', 'outflows', 'merchants', 'bank_accounts', 'channels', 'forwarder_devices',
                           'alert_channels', 'announcements', 'support_faqs', 'console_assets'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_at timestamptz', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_by text', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS delete_reason text', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (deleted_at) WHERE deleted_at IS NOT NULL', t || '_deleted_idx', t);
  END LOOP;
END $$;
