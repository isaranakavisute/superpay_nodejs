import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';
import { query, closePool } from '../src/db/pool.js';

/**
 * These tests run against the configured DATABASE_URL, which is a shared live
 * database. The default suite is therefore READ-ONLY: it asserts on data that
 * is already there and never inserts, updates, or deletes.
 *
 * Write-path tests are opt-in:
 *   TEST_ALLOW_WRITES=true npm test
 * They insert users with a recognisable email and delete them afterwards.
 */
const ALLOW_WRITES = process.env.TEST_ALLOW_WRITES === 'true';

let api;
const createdUserIds = [];

before(async () => {
  api = await startTestServer();
});

after(async () => {
  if (createdUserIds.length > 0) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      createdUserIds,
    ]);
  }
  await api?.close();
  await closePool();
});

describe('service root', () => {
  it('advertises the service and its endpoints', async () => {
    const res = await api.get('/');
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'superpayment');
    assert.ok(Array.isArray(res.body.endpoints));
  });
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await api.get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(typeof res.body.uptime, 'number');
  });

  it('reports readiness including the database', async () => {
    const res = await api.get('/readyz');
    assert.equal(res.status, 200, `unexpected body: ${res.text}`);
    assert.deepEqual(res.body, { status: 'ok', database: 'up' });
  });
});

describe('error handling', () => {
  it('returns a structured 404 for unknown routes', async () => {
    const res = await api.get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    assert.match(res.body.error.message, /GET \/api\/nope/);
  });

  it('rejects malformed JSON bodies', async () => {
    const res = await fetch(`${api.base}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_json');
  });

  it('does not leak a stack trace for handled errors', async () => {
    const res = await api.get('/api/users/not-a-uuid');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.stack, undefined);
  });
});

describe('GET /api/products', () => {
  it('returns a page of products with pagination metadata', async () => {
    const res = await api.get('/api/products?limit=5');
    assert.equal(res.status, 200, `unexpected body: ${res.text}`);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length <= 5);
    assert.equal(res.body.pagination.limit, 5);
    assert.ok(res.body.pagination.total >= res.body.data.length);
  });

  it('maps snake_case columns to camelCase fields', async () => {
    const res = await api.get('/api/products?limit=1');
    const [product] = res.body.data;
    assert.ok(product, 'expected at least one product in the database');
    for (const key of [
      'id',
      'name',
      'category',
      'price',
      'soldCount',
      'createdAt',
    ]) {
      assert.ok(key in product, `missing field ${key}`);
    }
    assert.equal(product.sold_count, undefined);
  });

  it('returns numeric and bigint columns as exact strings', async () => {
    const res = await api.get('/api/products?limit=1');
    const [product] = res.body.data;
    assert.equal(
      typeof product.id,
      'string',
      'bigint id must not lose precision',
    );
    if (product.rating !== null) {
      assert.equal(typeof product.rating, 'string', 'numeric must stay exact');
    }
  });

  it('honours limit and offset', async () => {
    const first = await api.get(
      '/api/products?limit=1&offset=0&sort=name&order=asc',
    );
    const second = await api.get(
      '/api/products?limit=1&offset=1&sort=name&order=asc',
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    if (first.body.pagination.total > 1) {
      assert.notEqual(first.body.data[0].id, second.body.data[0].id);
    }
  });

  it('sorts by price ascending', async () => {
    const res = await api.get('/api/products?sort=price&order=asc&limit=10');
    assert.equal(res.status, 200);
    const prices = res.body.data.map((p) => p.price);
    assert.deepEqual(
      prices,
      [...prices].sort((a, b) => a - b),
    );
  });

  it('filters by category', async () => {
    const categories = await api.get('/api/products/categories');
    assert.equal(categories.status, 200);
    const [first] = categories.body.data;
    assert.ok(first, 'expected at least one category');

    const res = await api.get(
      `/api/products?category=${encodeURIComponent(first.category)}&limit=100`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, first.productCount);
    assert.ok(res.body.data.every((p) => p.category === first.category));
  });

  it('filters by price range', async () => {
    const res = await api.get('/api/products?minPrice=0&maxPrice=1&limit=100');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.every((p) => p.price >= 0 && p.price <= 1));
  });

  it('rejects a price range that is inverted', async () => {
    const res = await api.get('/api/products?minPrice=100&maxPrice=10');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });

  it('rejects an unwhitelisted sort field', async () => {
    const res = await api.get('/api/products?sort=price;DROP TABLE products');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });

  it('rejects an out-of-range limit', async () => {
    const res = await api.get('/api/products?limit=1000');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });

  it('treats a search term as a literal, not a pattern', async () => {
    const res = await api.get('/api/products?q=%25');
    assert.equal(res.status, 200);
  });
});

describe('GET /api/products/:id', () => {
  it('returns a product by id', async () => {
    const list = await api.get('/api/products?limit=1');
    const [expected] = list.body.data;
    assert.ok(expected, 'expected at least one product');

    const res = await api.get(`/api/products/${expected.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, expected.id);
    assert.equal(res.body.name, expected.name);
  });

  it('returns 404 for a valid but unknown id', async () => {
    const res = await api.get('/api/products/9223372036854775807');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await api.get('/api/products/abc');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });
});

describe('GET /api/users', () => {
  it('returns a page of users', async () => {
    const res = await api.get('/api/users?limit=5');
    assert.equal(res.status, 200, `unexpected body: ${res.text}`);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(typeof res.body.pagination.total, 'number');
  });

  it('returns 404 for a well-formed but unknown uuid', async () => {
    const res = await api.get(
      '/api/users/00000000-0000-4000-8000-000000000000',
    );
    assert.equal(res.status, 404);
  });

  it('returns 400 for an id that is not a uuid', async () => {
    const res = await api.get('/api/users/12345');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });
});

describe('POST /api/users validation', () => {
  it('rejects an invalid email with field-level detail', async () => {
    const res = await api.post('/api/users', {
      email: 'not-an-email',
      name: 'X',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
    assert.ok(res.body.error.details.some((d) => d.path === 'email'));
  });

  it('rejects a missing name', async () => {
    const res = await api.post('/api/users', { email: 'a@example.com' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d) => d.path === 'name'));
  });

  it('rejects an empty PATCH body', async () => {
    const res = await api.patch(
      '/api/users/00000000-0000-4000-8000-000000000000',
      {},
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });
});

describe(
  'user write paths',
  { skip: ALLOW_WRITES ? false : 'set TEST_ALLOW_WRITES=true' },
  () => {
    const email = () =>
      `superpayment-test-${process.hrtime.bigint()}@example.test`;

    it('creates a user and normalises the email', async () => {
      const address = email().toUpperCase();
      const res = await api.post('/api/users', {
        email: address,
        name: 'Test',
      });
      assert.equal(res.status, 201, `unexpected body: ${res.text}`);
      createdUserIds.push(res.body.id);
      assert.equal(res.body.email, address.toLowerCase());
    });

    it('rejects a duplicate email with 409', async () => {
      const address = email();
      const first = await api.post('/api/users', { email: address, name: 'A' });
      assert.equal(first.status, 201);
      createdUserIds.push(first.body.id);

      const second = await api.post('/api/users', {
        email: address,
        name: 'B',
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'conflict');
    });

    it('updates a name and bumps updated_at', async () => {
      const created = await api.post('/api/users', {
        email: email(),
        name: 'Before',
      });
      assert.equal(created.status, 201);
      createdUserIds.push(created.body.id);

      const res = await api.patch(`/api/users/${created.body.id}`, {
        name: 'After',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'After');
      assert.ok(
        new Date(res.body.updatedAt) >= new Date(created.body.updatedAt),
        'updated_at should not go backwards',
      );
    });
  },
);
