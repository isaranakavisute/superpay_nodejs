import { query } from '../db/pool.js';

// Column list mirrors the pre-existing products table; nothing here alters it.
const COLUMNS = `
  id,
  name,
  category,
  emoji,
  price,
  original_price AS "originalPrice",
  rating,
  sold_count     AS "soldCount",
  location,
  created_at     AS "createdAt",
  updated_at     AS "updatedAt"
`;

export async function findProductById(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM products WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listProducts(filters) {
  const {
    q,
    category,
    location,
    minPrice,
    maxPrice,
    minRating,
    sort,
    order,
    limit,
    offset,
  } = filters;

  const conditions = [];
  const params = [];

  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('$?', `$${params.length}`));
  };

  if (q) add('name ILIKE $?', `%${q}%`);
  if (category) add('category = $?', category);
  if (location) add('location = $?', location);
  if (minPrice !== undefined) add('price >= $?', minPrice);
  if (maxPrice !== undefined) add('price <= $?', maxPrice);
  if (minRating !== undefined) add('rating >= $?', minRating);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  // sort/order come from a zod enum, so interpolation cannot inject SQL.
  const { rows } = await query(
    `SELECT ${COLUMNS}, count(*) OVER () AS "totalCount"
       FROM products
       ${where}
      ORDER BY ${sort} ${order.toUpperCase()}, id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: rows.map(({ totalCount: _t, ...product }) => product),
    total: rows.length > 0 ? Number(rows[0].totalCount) : 0,
  };
}

export async function listCategories() {
  const { rows } = await query(
    `SELECT category,
            count(*)::int AS "productCount",
            min(price)    AS "minPrice",
            max(price)    AS "maxPrice"
       FROM products
      WHERE category IS NOT NULL
      GROUP BY category
      ORDER BY category`,
  );
  return rows;
}
