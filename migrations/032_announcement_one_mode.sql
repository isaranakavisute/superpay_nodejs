-- ประชาสัมพันธ์: an announcement posts EITHER at chosen time slots (1.1) OR every interval (1.2) — never both.
ALTER TABLE announcements ADD CONSTRAINT announcements_one_mode CHECK (
  (mode = 'times'    AND cardinality(times) > 0 AND interval_seconds IS NULL AND start_at IS NULL) OR
  (mode = 'interval' AND cardinality(times) = 0 AND interval_seconds IS NOT NULL AND start_at IS NOT NULL)
);
