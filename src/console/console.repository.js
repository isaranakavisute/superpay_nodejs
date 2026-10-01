import { query } from '../db/pool.js';

/**
 * Builds WHERE for a registry resource. `skipStatus` drops the status filter
 * so the summary can count every status under the other filters (tab counts).
 */
function buildWhere(res, params, { q, from, to, filters }, { skipStatus = false } = {}) {
  const conditions = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replaceAll('$?', `$${params.length}`));
  };

  if (q && res.search) add(`(${res.search.map((c) => `${c} ILIKE $?`).join(' OR ')})`, `%${q}%`);
  if (from && res.time) add(`${res.time} >= $?`, from);
  if (to && res.time) add(`${res.time} < $?`, to);
  for (const [name, value] of Object.entries(filters)) {
    if (skipStatus && res.filters[name] === res.status) continue;
    // "a,b,c" matches any of the values (used for grouped buckets).
    if (value.includes(',')) add(`${res.filters[name]} = ANY($?::text[])`, value.split(',').map((v) => v.trim()).filter(Boolean));
    else add(`${res.filters[name]} = $?`, value);
  }
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

export async function list(res, args) {
  const params = [];
  const where = buildWhere(res, params, args);
  params.push(args.limit, args.offset);
  const { rows } = await query(
    `SELECT ${res.columns}, count(*) OVER () AS "totalCount"
       FROM ${res.from}
       ${where}
      ORDER BY ${res.order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    items: rows.map(({ totalCount: _t, ...row }) => row),
    total: rows.length > 0 ? Number(rows[0].totalCount) : await countAll(res, args),
  };
}

// A page past the end has no rows to carry the window count.
async function countAll(res, args) {
  if (args.offset === 0) return 0;
  const params = [];
  const where = buildWhere(res, params, args);
  const { rows } = await query(`SELECT count(*)::int AS n FROM ${res.from} ${where}`, params);
  return rows[0].n;
}

/** Count (and amount, if the resource has one) per status, ignoring the status filter. */
export async function summary(res, args) {
  if (!res.status) return [];
  const params = [];
  const where = buildWhere(res, params, args, { skipStatus: true });
  const { rows } = await query(
    `SELECT ${res.status} AS key, count(*)::int AS count${res.amount ? `, sum(${res.amount}) AS amount` : ''}${Object.entries(res.sums ?? {})
      .map(([alias, expr]) => `, sum(${expr}) AS "${alias}"`)
      .join('')}
       FROM ${res.from}
       ${where}
      GROUP BY 1
      ORDER BY 1`,
    params,
  );
  return rows;
}
