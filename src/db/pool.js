import pg from 'pg';
import config from '../config.js';
import logger from '../logger.js';

const { Pool, types } = pg;

// Return NUMERIC/DECIMAL as a string rather than a lossy float. Money columns
// must survive the round trip exactly.
types.setTypeParser(types.builtins.NUMERIC, (value) => value);
// BIGINT likewise — JS numbers cannot hold the full int8 range.
types.setTypeParser(types.builtins.INT8, (value) => value);

export const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'superpayment',
});

pool.on('error', (err) => {
  // Fires for idle clients dropped by the server; the pool discards them itself.
  logger.error({ err }, 'unexpected postgres pool error');
});

export async function query(text, params) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.debug({ sql: text, rows: result.rowCount, ms }, 'query');
    return result;
  } catch (err) {
    logger.error({ err, sql: text }, 'query failed');
    throw err;
  }
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on throw.
 * `client.afterCommit(cb)` queues side effects (e.g. outbound webhooks) that must
 * only happen once the data is durable; they run after COMMIT and never throw.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  const after = [];
  client.afterCommit = (cb) => after.push(cb);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    for (const cb of after) {
      try {
        cb();
      } catch (err) {
        logger.error({ err }, 'afterCommit callback failed');
      }
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    delete client.afterCommit;
    client.release();
  }
}

export async function healthCheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function closePool() {
  await pool.end();
}

export default pool;
