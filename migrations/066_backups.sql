-- Database backups (admin console → สำรองข้อมูล). Files live on the server in /var/backups/optionpay; the host-side
-- agent (/usr/local/sbin/optionpay-backup-agent.sh) keeps backup_files in sync and carries out backup_jobs.
CREATE TABLE IF NOT EXISTS backup_files (
  name        text PRIMARY KEY,                 -- superpay-YYYYMMDD-HHMM.dump
  taken_at    timestamptz NOT NULL,
  size_bytes  bigint NOT NULL,
  tables      integer,
  seen_at     timestamptz NOT NULL DEFAULT now()
);
-- 'backup' = take one now · 'restore' = replace the whole live database with `file` (Super Admin only).
CREATE TABLE IF NOT EXISTS backup_jobs (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('backup', 'restore')),
  file          text,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'done', 'failed')),
  step          text,
  requested_by  text NOT NULL,
  reason        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  message       text,
  kept_as       text                              -- restore: the replaced live database, kept under this name
);
-- At most one job waiting / running at a time.
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_one_open ON backup_jobs ((true)) WHERE status IN ('requested', 'running');
