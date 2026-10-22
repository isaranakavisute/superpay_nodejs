import { z } from 'zod';
import { query } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../errors.js';

/**
 * สำรองข้อมูล (admin console). Nightly backups are taken at 01:00 on the server
 * (/usr/local/sbin/optionpay-backup.sh) — nightly files kept forever, the change log 7 days. The backend can't touch the files: it lists what the host agent
 * reports in backup_files and queues backup_jobs, which the agent runs (optionpay-backup-agent.sh).
 */
export const restoreBodySchema = z.object({
  file: z.string().regex(/^superpay-\d{8}-\d{4}\.dump$/),
  reason: z.string().trim().min(5, 'กรุณาระบุเหตุผล (อย่างน้อย 5 ตัวอักษร)').max(300),
});
export const impactQuerySchema = z.object({ file: restoreBodySchema.shape.file });

export async function overview() {
  const [files, jobs, kept] = await Promise.all([
    query(`SELECT name, taken_at AS "takenAt", size_bytes AS "sizeBytes", tables, seen_at AS "seenAt" FROM backup_files ORDER BY taken_at DESC`),
    query(`SELECT id, kind, file, status, step, requested_by AS "requestedBy", reason, requested_at AS "requestedAt", started_at AS "startedAt",
                  finished_at AS "finishedAt", message, kept_as AS "keptAs" FROM backup_jobs ORDER BY id DESC LIMIT 20`),
    query(`SELECT datname AS name FROM pg_database WHERE datname LIKE 'db_before_restore_%' ORDER BY datname DESC`),
  ]);
  return { schedule: { time: '01:00', timezone: 'Asia/Bangkok', keepDays: null, changesKeepDays: 7 }, files: files.rows, jobs: jobs.rows, keptDatabases: kept.rows.map((r) => r.name) };
}

/** What a full restore to `file` throws away: everything created / changed after the backup was taken. */
export async function impact({ file }) {
  const { rows: [f] } = await query('SELECT taken_at FROM backup_files WHERE name = $1', [file]);
  if (!f) throw new NotFoundError('ไม่พบไฟล์สำรองข้อมูลนี้');
  const { rows: [r] } = await query(
    `SELECT (SELECT count(*) FROM payments WHERE created_at > $1)::int AS "paymentsCreated",
            (SELECT count(*) FROM payments WHERE created_at <= $1 AND completed_at > $1)::int AS "paymentsDecided",
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'approved' AND completed_at > $1) AS "approvedAmount",
            (SELECT count(*) FROM outflows WHERE created_at > $1)::int AS "payoutsCreated",
            (SELECT coalesce(sum(amount), 0) FROM outflows WHERE created_at > $1) AS "payoutAmount",
            (SELECT count(*) FROM withdrawal_requests WHERE created_at > $1)::int AS "withdrawalsCreated",
            (SELECT count(*) FROM webhook_deliveries WHERE delivered_at > $1)::int AS "callbacksSent",
            (SELECT count(*) FROM audit_logs WHERE created_at > $1)::int AS "auditEntries"`,
    [f.taken_at]);
  return { file, takenAt: f.taken_at, impact: r };
}

async function queue(kind, actor, b = {}) {
  try {
    const { rows } = await query(`INSERT INTO backup_jobs (kind, file, requested_by, reason) VALUES ($1, $2, $3, $4) RETURNING id`,
      [kind, b.file ?? null, actor ?? 'console', b.reason ?? null]);
    await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'backup', $3, $4)`,
      [actor ?? 'console', `backup.${kind}_request`, b.file ?? 'now',
        kind === 'restore' ? `ขอกู้คืนฐานข้อมูลทั้งหมดจาก ${b.file} — ${b.reason}` : 'ขอสำรองข้อมูลทันที']);
    return { jobId: rows[0].id };
  } catch (e) {
    if (e.code === '23505') throw new ConflictError('มีงานสำรอง/กู้คืนข้อมูลกำลังรอหรือทำอยู่ — รอให้เสร็จก่อน');
    throw e;
  }
}

export const requestBackup = (actor) => queue('backup', actor);

export async function requestRestore(actor, b) {
  const { rowCount } = await query('SELECT 1 FROM backup_files WHERE name = $1', [b.file]);
  if (!rowCount) throw new NotFoundError('ไม่พบไฟล์สำรองข้อมูลนี้');
  return queue('restore', actor, b);
}
