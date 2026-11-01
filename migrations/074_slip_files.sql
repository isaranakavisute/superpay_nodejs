-- Slip images as files (31 Oct 2026). Additive only: the image bytes stay in `data` (the fallback) until a later step.
--  1. `file_path`: where the image file is (relative to the backend's SLIP_STORE_DIR volume; named by its SHA-256).
--  2. The change log no longer copies slip images: every slip insert used to put the whole image (as hex, ~2× its size)
--     into change_log — most of its 18 GB. Slip rows are still logged, without `data`; their image is the file.
--     An update that only sets `file_path` (the one-off copy to files) is not logged at all.
--  3. Undo / replay cannot re-create a slip row from the log any more (no image in it) — it says so instead of failing.
SET lock_timeout = '10s';
ALTER TABLE payment_slips ADD COLUMN IF NOT EXISTS file_path text;
ALTER TABLE outflow_slips ADD COLUMN IF NOT EXISTS file_path text;

CREATE OR REPLACE FUNCTION log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb; k jsonb := '{}'; col text; r jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  -- Slip images live in files now: never copy their bytes into the log.
  IF TG_TABLE_NAME IN ('payment_slips', 'outflow_slips') THEN o := o - 'data'; n := n - 'data'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF o = n THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(n) x
                    WHERE o -> x IS DISTINCT FROM n -> x
                      AND x NOT IN ('last_used_at', 'last_sent_at', 'last_seen_at', 'secret_key_last_used_at', 'otp_last_used_at', 'file_path')) THEN
      RETURN NULL;
    END IF;
    -- Images (logos): kept when a row is added / deleted, not copied again on every update that leaves them alone.
    IF o ? 'data' AND o -> 'data' = n -> 'data' THEN o := o - 'data'; n := n - 'data'; END IF;
  END IF;
  r := CASE WHEN TG_OP = 'INSERT' THEN n ELSE o END;
  FOREACH col IN ARRAY TG_ARGV LOOP k := k || jsonb_build_object(col, r -> col); END LOOP;
  INSERT INTO change_log (tbl, op, pk, old_row, new_row, source)
  VALUES (TG_TABLE_NAME, left(TG_OP, 1), k, o, n, nullif(current_setting('optionpay.change_source', true), ''));
  RETURN NULL;
END $$;

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
  -- A slip row logged without its image (074) cannot be re-created from the log.
  IF cur IS NULL AND target IS NOT NULL AND c.tbl IN ('payment_slips', 'outflow_slips') AND NOT target ? 'data' THEN
    RETURN 'conflict: รูปสลิปเก็บเป็นไฟล์ ไม่ได้อยู่ในประวัติ — กู้คืนแถวสลิปนี้อัตโนมัติไม่ได้';
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
