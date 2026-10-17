-- Once-a-day jobs (e.g. the midnight cancellation): the Bangkok day each last ran for, claimed with an UPDATE so a
-- day runs once even across restarts. Seeded with today so deploying does not run tonight's job early.
CREATE TABLE daily_jobs (
  job          text PRIMARY KEY,
  last_run_for date NOT NULL,
  last_run_at  timestamptz,
  last_result  jsonb
);
INSERT INTO daily_jobs (job, last_run_for) VALUES ('midnight_cancel', (now() AT TIME ZONE 'Asia/Bangkok')::date);
