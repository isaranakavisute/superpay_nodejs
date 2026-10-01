#!/usr/bin/env node
/** Prints connection details and the current schema. Handy smoke test. */
import { pool, closePool } from '../src/db/pool.js';

try {
  const { rows: info } = await pool.query(
    `SELECT current_database() AS database,
            current_user       AS "user",
            version()          AS version,
            inet_server_addr() AS host,
            inet_server_port() AS port`,
  );
  const { database, user, version, host, port } = info[0];
  console.log(`connected  ${user}@${host}:${port}/${database}`);
  console.log(`server     ${version.split(' on ')[0]}`);

  const { rows: tables } = await pool.query(
    `SELECT table_name AS name,
            (SELECT count(*) FROM information_schema.columns c
              WHERE c.table_schema = t.table_schema
                AND c.table_name = t.table_name) AS columns
       FROM information_schema.tables t
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );

  if (tables.length === 0) {
    console.log('\nNo tables in public schema. Run: npm run migrate');
  } else {
    console.log(`\ntables in public (${tables.length}):`);
    for (const t of tables) {
      console.log(`  ${t.name.padEnd(24)} ${t.columns} columns`);
    }
  }
} catch (err) {
  console.error(`connection failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
