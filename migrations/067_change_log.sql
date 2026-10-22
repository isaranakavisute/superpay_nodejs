-- Real-time change log (สำรองข้อมูล → บันทึกการเปลี่ยนแปลง): every INSERT / UPDATE / DELETE on business tables, the row
-- before and after, written in the same transaction by trigger zz_change_log. Between nightly backups (01:00) an admin can
-- UNDO changes (put rows back as they were) or REPLAY them (apply again, e.g. after a full restore) — change_apply() below.
-- The host agent also appends it to /var/backups/optionpay/changes-YYYYMMDD.jsonl every 5 minutes; rows are kept 14 days.
CREATE TABLE IF NOT EXISTS change_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid     bigint NOT NULL DEFAULT txid_current(),
  tbl      text NOT NULL,
  op       char(1) NOT NULL CHECK (op IN ('I', 'U', 'D')),
  pk       jsonb NOT NULL,
  old_row  jsonb,
  new_row  jsonb,
  source   text           -- NULL = normal work; 'undo …' / 'replay …' when written by change_apply
);
CREATE INDEX IF NOT EXISTS change_log_at ON change_log (at);
CREATE INDEX IF NOT EXISTS change_log_tbl_pk ON change_log (tbl, pk);
CREATE INDEX IF NOT EXISTS change_log_txid ON change_log (txid);

-- Who did it: audit entries carry their transaction id, matched to change_log.txid.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS txid bigint DEFAULT txid_current();
CREATE INDEX IF NOT EXISTS audit_logs_txid ON audit_logs (txid);

CREATE OR REPLACE FUNCTION log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb; k jsonb := '{}'; col text; r jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    IF o = n THEN RETURN NULL; END IF;
    -- Images (slips, logos): kept when a row is added / deleted, not copied again on every update that leaves them alone.
    IF o ? 'data' AND o -> 'data' = n -> 'data' THEN o := o - 'data'; n := n - 'data'; END IF;
  END IF;
  r := CASE WHEN TG_OP = 'INSERT' THEN n ELSE o END;
  FOREACH col IN ARRAY TG_ARGV LOOP k := k || jsonb_build_object(col, r -> col); END LOOP;
  INSERT INTO change_log (tbl, op, pk, old_row, new_row, source)
  VALUES (TG_TABLE_NAME, left(TG_OP, 1), k, o, n, nullif(current_setting('optionpay.change_source', true), ''));
  RETURN NULL;
END $$;

-- Business tables only (logs such as audit_logs / api_request_logs / webhook_deliveries are already a history).
DO $$
DECLARE t text; cols text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_channels','announcements','bank_account_merchants','bank_accounts','banks','channels','console_assets',
    'console_config','console_roles','console_settings','console_user_profiles','demo_records','double_credits','fee_splits',
    'forwarder_devices','inbound_events','merchant_api_keys','merchant_credit_adjustments','merchant_portal_users','merchants',
    'outflow_slips','outflows','p2p_matches','payment_slips','payments','private_records','slip_transfer_uses','slip_transfers',
    'support_faqs','telegram_bot_chats','user_password','webhook_endpoints','withdrawal_requests'] LOOP
    SELECT string_agg(quote_literal(a.attname), ',' ORDER BY array_position(i.indkey::int[], a.attnum::int)) INTO cols
      FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = t::regclass AND i.indisprimary;
    EXECUTE format('DROP TRIGGER IF EXISTS zz_change_log ON %I', t);
    EXECUTE format('CREATE TRIGGER zz_change_log AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION log_change(%s)', t, cols);
  END LOOP;
END $$;

-- Undo / replay one logged change. undo: the row must still look as the change left it, then it is put back (old_row);
-- replay: the row must look as it did before, then the change is applied again (new_row). Otherwise → 'conflict: …' and
-- nothing is written (the caller skips it). Columns missing from a row (an unchanged image) are left alone.
CREATE OR REPLACE FUNCTION change_apply(p_id bigint, p_mode text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE c change_log; cur jsonb; expect jsonb; target jsonb; w text; sets text; rel regclass;
BEGIN
  SELECT * INTO c FROM change_log WHERE id = p_id;
  IF NOT FOUND THEN RETURN 'conflict: ไม่พบรายการเปลี่ยนแปลงนี้'; END IF;
  rel := c.tbl::regclass;
  SELECT string_agg(format('t.%I = (jsonb_populate_record(NULL::%s, %L::jsonb)).%I', k, rel, c.pk, k), ' AND ') INTO w FROM jsonb_object_keys(c.pk) k;
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %s', rel, w) INTO cur;
  IF p_mode = 'undo' THEN expect := c.new_row; target := c.old_row;
  ELSIF p_mode = 'replay' THEN expect := c.old_row; target := c.new_row;
  ELSE RAISE EXCEPTION 'mode must be undo or replay'; END IF;
  IF expect IS NULL THEN
    IF cur IS NOT NULL THEN RETURN 'conflict: มีข้อมูลนี้อยู่แล้ว'; END IF;
  ELSE
    IF cur IS NULL THEN RETURN 'conflict: ไม่พบข้อมูลนี้แล้ว (ถูกลบไป)'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(expect) e WHERE cur -> e.key IS DISTINCT FROM e.value) THEN
      RETURN 'conflict: ข้อมูลถูกแก้ไขอีกหลังจากนั้น';
    END IF;
  END IF;
  IF target IS NULL THEN
    EXECUTE format('DELETE FROM %s t WHERE %s', rel, w);
  ELSIF cur IS NULL THEN
    EXECUTE format('INSERT INTO %s SELECT * FROM jsonb_populate_record(NULL::%s, %L::jsonb)', rel, rel, target);
  ELSE
    SELECT string_agg(format('%I = r.%I', k, k), ', ') INTO sets FROM jsonb_object_keys(target) k;
    EXECUTE format('UPDATE %s t SET %s FROM jsonb_populate_record(NULL::%s, %L::jsonb) r WHERE %s', rel, sets, rel, target, w);
  END IF;
  RETURN 'ok';
END $$;
