-- ประชาสัมพันธ์: 1.3 'now' = post once, immediately when saved (replaces the "ส่งทันที" button);
-- 1.1 'times' can run every day (on_date NULL) or only on one Bangkok date (on_date, "เฉพาะวันนี้").
ALTER TABLE announcements ADD COLUMN on_date date;
ALTER TABLE announcements DROP CONSTRAINT announcements_mode_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_mode_check CHECK (mode IN ('times', 'interval', 'now'));
ALTER TABLE announcements DROP CONSTRAINT announcements_one_mode;
ALTER TABLE announcements ADD CONSTRAINT announcements_one_mode CHECK (
  (mode = 'times'    AND cardinality(times) > 0 AND interval_seconds IS NULL AND start_at IS NULL) OR
  (mode = 'interval' AND cardinality(times) = 0 AND interval_seconds IS NOT NULL AND start_at IS NOT NULL AND on_date IS NULL) OR
  (mode = 'now'      AND cardinality(times) = 0 AND interval_seconds IS NULL AND start_at IS NULL AND on_date IS NULL)
);
