-- Change log: skip updates that only stamp a "last used / last sent" time (every API call touches merchant_api_keys,
-- every Telegram alert touches alert_channels) — thousands of rows a day with nothing worth undoing. Real edits of the
-- same rows are still logged in full.
CREATE OR REPLACE FUNCTION log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb; k jsonb := '{}'; col text; r jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    IF o = n THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(n) x
                    WHERE o -> x IS DISTINCT FROM n -> x
                      AND x NOT IN ('last_used_at', 'last_sent_at', 'last_seen_at', 'secret_key_last_used_at', 'otp_last_used_at')) THEN
      RETURN NULL;
    END IF;
    -- Images (slips, logos): kept when a row is added / deleted, not copied again on every update that leaves them alone.
    IF o ? 'data' AND o -> 'data' = n -> 'data' THEN o := o - 'data'; n := n - 'data'; END IF;
  END IF;
  r := CASE WHEN TG_OP = 'INSERT' THEN n ELSE o END;
  FOREACH col IN ARRAY TG_ARGV LOOP k := k || jsonb_build_object(col, r -> col); END LOOP;
  INSERT INTO change_log (tbl, op, pk, old_row, new_row, source)
  VALUES (TG_TABLE_NAME, left(TG_OP, 1), k, o, n, nullif(current_setting('optionpay.change_source', true), ''));
  RETURN NULL;
END $$;
-- The stamps already logged since 067 went live are noise too.
DELETE FROM change_log c WHERE c.op = 'U' AND NOT EXISTS (
  SELECT 1 FROM jsonb_object_keys(c.new_row) x WHERE c.old_row -> x IS DISTINCT FROM c.new_row -> x
    AND x NOT IN ('last_used_at', 'last_sent_at', 'last_seen_at', 'secret_key_last_used_at', 'otp_last_used_at'));
