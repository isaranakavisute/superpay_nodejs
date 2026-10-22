import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../errors.js';

/**
 * Real-time change log (migration 067; kept 7 days): every write to a business table, grouped by database transaction (one
 * console / API action = one transaction). Admins browse it day by day and UNDO or REPLAY chosen transactions or a
 * whole time range; change_apply() does each row and refuses (conflict) when the row has changed since.
 */
const TZ = 'Asia/Bangkok';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const listQuerySchema = z.object({
  day,
  from: hhmm.default('00:00'),
  to: hhmm.default('23:59'),
  table: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const applyBodySchema = z.object({
  mode: z.enum(['undo', 'replay']),
  txids: z.array(z.coerce.number().int().positive()).max(2000).optional(),
  range: z.object({ day, from: hhmm, to: hhmm, table: z.string().regex(/^[a-z_]{2,40}$/).optional() }).optional(),
}).refine((b) => (b.txids?.length ?? 0) > 0 || b.range, 'เลือกรายการ หรือช่วงเวลา');

const MAX_CHANGES = 5000;
// Window [from, to] of one Bangkok day, `to` inclusive to the end of that minute.
const bounds = (d, from, to) => [`${d} ${from}:00+07`, `${d} ${to}:59.999999+07`];

export async function days() {
  const { rows } = await query(
    `SELECT to_char(at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day, count(*)::int AS changes, count(DISTINCT txid)::int AS transactions,
            min(at) AS "firstAt", max(at) AS "lastAt"
       FROM change_log GROUP BY 1 ORDER BY 1 DESC`);
  const { rows: [t] } = await query(`SELECT array_agg(DISTINCT tbl ORDER BY tbl) AS tables FROM change_log`);
  return { days: rows, tables: t.tables ?? [] };
}

/** Transactions in a time window, newest first, each with its row changes and the audit entries written with it. */
export async function transactions(f) {
  const [a, b] = bounds(f.day, f.from, f.to);
  const args = [a, b, f.limit];
  let extra = '';
  if (f.table) { args.push(f.table); extra += ` AND c.tbl = $${args.length}`; }
  if (f.q) {
    args.push(`%${f.q}%`);
    extra += ` AND (c.pk::text ILIKE $${args.length} OR coalesce(c.new_row, c.old_row) ->> 'ref' ILIKE $${args.length}
               OR coalesce(c.new_row, c.old_row) ->> 'slug' ILIKE $${args.length} OR coalesce(c.new_row, c.old_row) ->> 'merchant_order_id' ILIKE $${args.length}
               OR EXISTS (SELECT 1 FROM audit_logs x WHERE x.txid = c.txid AND (x.actor ILIKE $${args.length} OR x.entity_ref ILIKE $${args.length})))`;
  }
  const { rows } = await query(
    `WITH hit AS (SELECT DISTINCT c.txid FROM change_log c WHERE c.at BETWEEN $1 AND $2 ${extra})
     SELECT c.txid::text AS txid, min(c.at) AS at, count(*)::int AS "changeCount", max(c.source) AS source,
            jsonb_agg(jsonb_build_object(
              'id', c.id, 'tbl', c.tbl, 'op', c.op, 'pk', c.pk,
              'label', coalesce(coalesce(c.new_row, c.old_row) ->> 'ref', coalesce(c.new_row, c.old_row) ->> 'slug',
                                coalesce(c.new_row, c.old_row) ->> 'name', coalesce(c.new_row, c.old_row) ->> 'key'),
              'changed', CASE WHEN c.op = 'U' THEN (SELECT jsonb_agg(k) FROM jsonb_object_keys(c.new_row) k
                                                    WHERE c.old_row -> k IS DISTINCT FROM c.new_row -> k) END,
              'status', CASE WHEN c.op = 'D' THEN c.old_row ->> 'status' ELSE c.new_row ->> 'status' END,
              'statusBefore', CASE WHEN c.op = 'U' THEN c.old_row ->> 'status' END
            ) ORDER BY c.id) AS changes,
            (SELECT jsonb_agg(jsonb_build_object('actor', x.actor, 'action', x.action, 'ref', x.entity_ref, 'detail', left(x.detail, 200)) ORDER BY x.id)
               FROM audit_logs x WHERE x.txid = c.txid) AS audits
       FROM change_log c JOIN hit USING (txid)
      GROUP BY c.txid ORDER BY min(c.at) DESC LIMIT $3`, args);
  const { rows: [n] } = await query(`SELECT count(DISTINCT c.txid)::int AS n FROM change_log c WHERE c.at BETWEEN $1 AND $2 AND $3::int > 0 ${extra}`, args);
  return { transactions: rows, total: n.n, limit: f.limit };
}

/** One change in full (images shortened). */
export async function change(id) {
  const { rows } = await query(
    `SELECT id, at, txid::text AS txid, tbl, op, pk, source,
            CASE WHEN old_row ? 'data' THEN old_row - 'data' || '{"data": "(รูปภาพ)"}' ELSE old_row END AS "oldRow",
            CASE WHEN new_row ? 'data' THEN new_row - 'data' || '{"data": "(รูปภาพ)"}' ELSE new_row END AS "newRow"
       FROM change_log WHERE id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('ไม่พบรายการเปลี่ยนแปลงนี้');
  return { change: rows[0] };
}

async function changeIds(c, b) {
  if (b.txids?.length) {
    const { rows } = await c.query(`SELECT id FROM change_log WHERE txid = ANY ($1::bigint[]) ORDER BY id`, [b.txids]);
    return rows.map((r) => r.id);
  }
  const [a, z2] = bounds(b.range.day, b.range.from, b.range.to);
  const { rows } = await c.query(`SELECT id FROM change_log WHERE at BETWEEN $1 AND $2 ${b.range.table ? 'AND tbl = $3' : ''} ORDER BY id`,
    b.range.table ? [a, z2, b.range.table] : [a, z2]);
  return rows.map((r) => r.id);
}

/**
 * Undo (newest first) or replay (oldest first) the chosen changes in ONE database transaction, each under its own
 * savepoint: a conflict or error skips that row only. `dry` = preview: everything is rolled back at the end.
 */
export async function apply(actor, b, { dry }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ids = await changeIds(c, b);
    if (!ids.length) throw new BadRequestError('ไม่มีรายการเปลี่ยนแปลงในที่เลือก');
    if (ids.length > MAX_CHANGES) throw new BadRequestError(`มีการเปลี่ยนแปลง ${ids.length.toLocaleString()} แถว — ทำได้ครั้งละไม่เกิน ${MAX_CHANGES.toLocaleString()} แถว ให้เลือกช่วงเวลาให้แคบลง`);
    if (b.mode === 'undo') ids.reverse();
    const what = b.txids?.length ? `${b.txids.length} รายการที่เลือก` : `ช่วง ${b.range.day} ${b.range.from}–${b.range.to}${b.range.table ? ` (${b.range.table})` : ''}`;
    await c.query(`SELECT set_config('optionpay.change_source', $1, true)`, [`${b.mode === 'undo' ? 'ย้อนกลับ' : 'ทำซ้ำ'} ${what} โดย ${actor ?? 'console'}`]);
    const results = [];
    for (const id of ids) {
      await c.query('SAVEPOINT one');
      try {
        const { rows } = await c.query('SELECT change_apply($1, $2) AS r', [id, b.mode]);
        results.push({ id, result: rows[0].r });
        await c.query('RELEASE SAVEPOINT one');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT one');
        results.push({ id, result: `error: ${e.message}` });
      }
    }
    const ok = results.filter((r) => r.result === 'ok').length;
    const summary = { total: results.length, ok, conflicts: results.filter((r) => r.result.startsWith('conflict')).length, errors: results.filter((r) => r.result.startsWith('error')).length };
    if (dry) await c.query('ROLLBACK');
    else {
      await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'backup', $3, $4)`,
        [actor ?? 'console', `changes.${b.mode}`, b.txids?.length ? `${b.txids.length} tx` : `${b.range.day} ${b.range.from}-${b.range.to}`,
          `${b.mode === 'undo' ? 'ย้อนกลับ' : 'ทำซ้ำ'}การเปลี่ยนแปลง ${what}: สำเร็จ ${ok}/${results.length} แถว · ชนกัน ${summary.conflicts} · ผิดพลาด ${summary.errors}`]);
      await c.query('COMMIT');
    }
    // Details of the rows that were skipped (to show the admin why).
    const skipped = results.filter((r) => r.result !== 'ok').slice(0, 200);
    const { rows: info } = skipped.length
      ? await query(`SELECT id, tbl, op, coalesce(coalesce(new_row, old_row) ->> 'ref', pk::text) AS label FROM change_log WHERE id = ANY ($1)`, [skipped.map((r) => r.id)])
      : { rows: [] };
    const byId = new Map(info.map((r) => [r.id, r]));
    return { dry, summary, skipped: skipped.map((r) => ({ ...r, ...byId.get(r.id) })) };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
