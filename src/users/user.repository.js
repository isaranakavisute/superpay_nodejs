import { query } from '../db/pool.js';

const COLUMNS = `
  id,
  email,
  name,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function findUserById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

export async function findUserByEmail(email, client) {
  const runner = client ? (t, p) => client.query(t, p) : query;
  const { rows } = await runner(
    `SELECT ${COLUMNS} FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function listUsers({ q, limit, offset }) {
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE email ILIKE $1 OR name ILIKE $1`;
  }
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT ${COLUMNS}, count(*) OVER () AS "totalCount"
       FROM users
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: rows.map(({ totalCount: _t, ...user }) => user),
    total: rows.length > 0 ? Number(rows[0].totalCount) : 0,
  };
}

export async function insertUser({ email, name }, client) {
  const runner = client ? (t, p) => client.query(t, p) : query;
  const { rows } = await runner(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [email, name],
  );
  return rows[0];
}

/** Partial update; `updated_at` is bumped explicitly (no trigger on this table). */
const UPDATABLE_COLUMNS = new Set(['email', 'name']);

export async function updateUser(id, patch, client) {
  const runner = client ? (t, p) => client.query(t, p) : query;
  const sets = [];
  const params = [id];

  for (const [column, value] of Object.entries(patch)) {
    // Guard the identifier: column names cannot be parameterised.
    if (value === undefined || !UPDATABLE_COLUMNS.has(column)) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return findUserById(id);

  sets.push('updated_at = now()');
  const { rows } = await runner(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}
