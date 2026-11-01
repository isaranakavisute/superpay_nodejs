// One-off (2 Nov 2026), slip images step 2: remove the in-database copy of slip images that are safely in files.
// A row is cleared only when its file exists, its bytes hash to the file's own name, AND the database copy hashes to that
// same name — the last check runs inside the UPDATE, so a slip replaced meanwhile is left alone. Anything else keeps its
// database copy and is reported. Safe to re-run; needs migration 076 (data may be NULL).
// Run inside the backend container:  node scripts/slips-db-copies-clear.js   (BATCH / PAUSE_MS / STOP_AT env)
import fs from 'node:fs';
import { pool, query } from '../src/db/pool.js';
import { readSlipFile } from '../src/shared/slip-store.js';

const BATCH = Number(process.env.BATCH ?? 50);
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 200);
const STOP_AT = Number(process.env.STOP_AT ?? Infinity);   // epoch ms: stop cleanly here (morning traffic)
const NAME = /([0-9a-f]{64})\.(jpg|png|webp)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load1 = () => Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const TABLES = [{ table: 'payment_slips', key: 'payment_id' }, { table: 'outflow_slips', key: 'outflow_id' }];

async function clearTable({ table, key }) {
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE data IS NOT NULL`);
  console.log(`${table}: ${n} database copies`);
  let last = 0, cleared = 0, noFile = 0, badFile = 0, differs = 0, stopped = false;
  for (;;) {
    if (Date.now() > STOP_AT) { stopped = true; break; }
    while (load1() > 4) await sleep(30_000);   // the server is busy: wait
    const { rows } = await query(`SELECT ${key} AS id, file_path FROM ${table} WHERE data IS NOT NULL AND ${key} > $1 ORDER BY ${key} LIMIT $2`, [last, BATCH]);
    if (!rows.length) break;
    const ids = [], hashes = [];
    for (const r of rows) {
      last = r.id;
      const name = NAME.exec(r.file_path ?? '');
      if (!name) { noFile += 1; console.error(`  no file: ${table} ${key}=${r.id}`); continue; }
      if (!(await readSlipFile(r.file_path))) { badFile += 1; console.error(`  file missing / damaged: ${table} ${key}=${r.id}`); continue; }
      ids.push(r.id); hashes.push(name[1]);
    }
    if (ids.length) {
      const { rowCount } = await query(
        `UPDATE ${table} s SET data = NULL FROM unnest($1::bigint[], $2::text[]) AS v(id, h)
          WHERE s.${key} = v.id AND s.data IS NOT NULL AND encode(sha256(s.data), 'hex') = v.h`, [ids, hashes]);
      cleared += rowCount; differs += ids.length - rowCount;
    }
    if (cleared % 1000 < BATCH) console.log(`  ${table}: ${cleared} cleared, ${noFile + badFile + differs} kept`);
    await sleep(PAUSE_MS);
  }
  const { rows: [{ left }] } = await query(`SELECT count(*)::int AS left FROM ${table} WHERE data IS NOT NULL`);
  console.log(`${table}: ${stopped ? 'STOPPED at the time limit' : 'done'} — ${cleared} cleared · kept: ${noFile} without a file, ${badFile} file missing/damaged, ${differs} file ≠ database copy · ${left} database copies left`);
  return { stopped, kept: noFile + badFile + differs };
}

const started = Date.now();
let stopped = false, kept = 0;
for (const t of TABLES) { const r = await clearTable(t); stopped ||= r.stopped; kept += r.kept; if (stopped) break; }
console.log(`${stopped ? 'STOPPED-AT-TIME-LIMIT' : kept ? 'CLEARED-WITH-KEPT' : 'ALL-CLEARED'} in ${Math.round((Date.now() - started) / 1000)} s`);
await pool.end();
process.exit(0);
