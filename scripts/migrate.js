#!/usr/bin/env node
/**
 * Minimal forward-only SQL migration runner.
 *
 * Each file in ./migrations is applied once, in filename order, inside a
 * transaction, and recorded in schema_migrations with a checksum. Editing an
 * already-applied file is reported as drift rather than silently ignored.
 *
 * Usage: node scripts/migrate.js [up|status]
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction, closePool } from '../src/db/pool.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

const checksum = (sql) => createHash('sha256').update(sql).digest('hex');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    }),
  );
}

async function loadApplied() {
  const { rows } = await pool.query(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return new Map(rows.map((r) => [r.name, r]));
}

async function up() {
  await ensureMigrationsTable();
  const [migrations, applied] = await Promise.all([
    loadMigrations(),
    loadApplied(),
  ]);

  let count = 0;
  for (const migration of migrations) {
    const record = applied.get(migration.name);
    if (record) {
      if (record.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} was modified after it was applied. ` +
            `Add a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    process.stdout.write(`applying ${migration.name} ... `);
    await withTransaction(async (client) => {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum],
      );
    });
    process.stdout.write('done\n');
    count += 1;
  }

  console.log(
    count > 0
      ? `${count} migration(s) applied.`
      : 'Database is already up to date.',
  );
}

async function status() {
  await ensureMigrationsTable();
  const [migrations, applied] = await Promise.all([
    loadMigrations(),
    loadApplied(),
  ]);

  if (migrations.length === 0) {
    console.log('No migration files in ./migrations.');
  }

  for (const migration of migrations) {
    const record = applied.get(migration.name);
    if (!record) {
      console.log(`pending   ${migration.name}`);
    } else if (record.checksum !== migration.checksum) {
      console.log(`MODIFIED  ${migration.name}  (checksum drift)`);
    } else {
      console.log(
        `applied   ${migration.name}  ${record.applied_at.toISOString()}`,
      );
    }
  }

  // This database is shared with another project whose migrations live
  // elsewhere; surface them instead of pretending they do not exist.
  const names = new Set(migrations.map((m) => m.name));
  for (const [name, record] of applied) {
    if (!names.has(name)) {
      console.log(
        `external  ${name}  ${record.applied_at.toISOString()}  (applied, file not in ./migrations)`,
      );
    }
  }
}

const command = process.argv[2] ?? 'up';
const commands = { up, status };

if (!commands[command]) {
  console.error(`Unknown command "${command}". Expected: up | status`);
  process.exit(1);
}

try {
  await commands[command]();
} catch (err) {
  console.error(`\nMigration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
