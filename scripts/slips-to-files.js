// One-off (31 Oct 2026): copy slip images that exist only in the database to files (src/shared/slip-store.js).
// Safe to re-run: rows that already have file_path are skipped. Each file is read back and compared byte-for-byte with
// the database copy before file_path is recorded; nothing is deleted from the database.
// Run inside the backend container:  node scripts/slips-to-files.js   (BATCH / PAUSE_MS env to tune)
import { pool, query } from '../src/db/pool.js';
import { readSlipFile, saveSlipFile, sha256, SLIP_DIR } from '../src/shared/slip-store.js';

const BATCH = Number(process.env.BATCH ?? 50);
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABLES = [{ table: 'payment_slips', key: 'payment_id', kind: 'payment' }, { table: 'outflow_slips', key: 'outflow_id', kind: 'outflow' }];

async function copyTable({ table, key, kind }) {
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE file_path IS NULL`);
  console.log(`${table}: ${n} to copy`);
  let last = 0, copied = 0, failed = 0, bytes = 0;
  for (;;) {
    const { rows } = await query(`SELECT ${key} AS id, mime, data, uploaded_at FROM ${table} WHERE file_path IS NULL AND ${key} > $1 ORDER BY ${key} LIMIT $2`, [last, BATCH]);
    if (!rows.length) break;
    for (const r of rows) {
      last = r.id;
      const rel = await saveSlipFile(kind, r.data, r.mime, sha256(r.data), r.uploaded_at ?? new Date());
      const back = rel ? await readSlipFile(rel) : null;
      if (!back || !back.equals(r.data)) { failed += 1; console.error(`  FAILED ${table} ${key}=${r.id}`); continue; }
      await query(`UPDATE ${table} SET file_path = $2 WHERE ${key} = $1 AND file_path IS NULL`, [r.id, rel]);
      copied += 1; bytes += r.data.length;
    }
    if (copied % 1000 < BATCH) console.log(`  ${table}: ${copied} copied (${(bytes / 1048576).toFixed(0)} MB), ${failed} failed`);
    await sleep(PAUSE_MS);
  }
  const { rows: [{ left }] } = await query(`SELECT count(*)::int AS left FROM ${table} WHERE file_path IS NULL`);
  console.log(`${table}: done — ${copied} copied (${(bytes / 1048576).toFixed(0)} MB), ${failed} failed, ${left} still without a file`);
  return { copied, failed, left };
}

const started = Date.now();
console.log(`copying slip images to ${SLIP_DIR}`);
let bad = 0;
for (const t of TABLES) { const r = await copyTable(t); bad += r.failed + r.left; }
console.log(`${bad ? 'FINISHED WITH PROBLEMS' : 'ALL-COPIED'} in ${Math.round((Date.now() - started) / 1000)} s`);
await pool.end();
process.exit(bad ? 1 : 0);
