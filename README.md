# superpayment

Node.js REST API (Express 5, ESM) over an existing PostgreSQL 17 database.

- **Local dev on port 3001** (`PORT` in `.env`); **Docker image on port 4650**
- **Adds its own tables only** (migrations 002–005); never alters tables other projects own — see [Database](#database)

## Requirements

- Node.js >= 20.11 (developed on 24; see `.nvmrc`)
- Network access to the PostgreSQL host

## Setup

```bash
npm install
npm run db:check     # verify connectivity and print the live schema
npm start            # http://localhost:3001
```

`npm run dev` restarts on file changes via `node --watch`.

> **npm cache note.** `~/.npm/_cacache` on this machine contains root-owned
> files from an earlier `sudo npm`, which makes `npm install` fail with
> `EACCES`. Either install with `npm install --cache /tmp/npm-cache` or fix it
> once with `sudo chown -R 501:20 ~/.npm`.

## Configuration

`.env` is git-ignored; `.env.example` documents the shape.

| Variable            | Default       | Notes                                                  |
| ------------------- | ------------- | ------------------------------------------------------ |
| `NODE_ENV`          | `development` | `development` \| `test` \| `production`                |
| `PORT`              | `3001`        |                                                        |
| `LOG_LEVEL`         | `info`        | pino level                                             |
| `LOG_SILENT`        | `false`       | `1` mutes all logging (used by `npm test`)             |
| `DATABASE_URL`      | —             | required; percent-encode reserved chars (`#` -> `%23`) |
| `DATABASE_SSL`      | `false`       | `true` enables TLS                                     |
| `DATABASE_POOL_MAX` | `10`          | pool size                                              |

Every variable is validated by zod at boot (`src/config.js`); a bad value fails
fast with a readable message instead of surfacing later as `NaN` or `undefined`.

**Precedence.** Outside production, `.env` _overrides_ real environment
variables. This machine exports `PORT=0` from a shell profile, which would
otherwise shadow `.env` and bind a random port. In production the real
environment always wins, so a stray `.env` can never override a deployment.
`LOG_SILENT` is deliberately absent from `.env` so it stays settable inline.

## Database

`DATABASE_URL` points at a **shared, live** database. It already contained, at
setup time:

| Table               | Rows                                   | Owner           |
| ------------------- | -------------------------------------- | --------------- |
| `products`          | 30                                     | pre-existing    |
| `user_password`     | 8                                      | pre-existing    |
| `users`             | 0                                      | pre-existing    |
| `schema_migrations` | 1 (`001_create_users.sql`, 2026-09-27) | another project |

This service **never alters those tables.** It adds its own, additively:

| Migration                          | Adds                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `002_create_payment_tables.sql`    | `banks`, `merchants`, `bank_accounts`, `payments`, `outflows` |
| `003_merchant_opening_balance.sql` | `merchants.opening_balance`                                   |
| `004_console_tables.sql`           | console tables: roles, profiles, logins, audit log, withdrawals, channels, events, devices, webhooks, alerts, settings, P2P, double credits |
| `005_account_details.sql`          | account holder/number, payer masked account, commission, merchant minimum balance |
| `006`–`019`                        | console detail columns: counters reset, P2P / double-credit detail, payment review + slips, outflow / withdrawal detail, merchant admin (API keys, credits, portal users, webhook secrets), webhook deliveries, channel config, event detail, devices, alert bots, user soft delete |
| `020_user_2fa.sql`                 | TOTP 2FA on console profiles (sealed secret, replay guard), password-changed time |
| `021_console_config.sql`           | `console_config` (settings page, one jsonb per section) and `console_assets` (logo, favicon, alert sounds) |
| `022_merchant_api.sql`             | merchant API v1: checkout token / expiry / source on payments, slip verification result, payout refs + idempotency, PromptPay id + owner shop on accounts, portal login (scrypt) |

Test logins created by the seed: every shop owner can sign in to the Merchant
Portal / `POST /api/auth/login` as `<slug>@shop.example` / `merchant1234`.

`npm run seed:dashboard` fills all of this service's tables with 60 days of
deterministic test data ending now (it empties and refills only them;
`scripts/seed-console-data.js` covers the 004 tables). It only *reads*
`user_password`, to attach a console profile to each account. Re-run it to move the
data window forward; "today" on the dashboard is empty once the seed day passes.

One row was added to the pre-existing `user_password` table: `admin`/`admin`
(id 9) for console login. The original `admin` row (id 7) is untouched.

Two consequences worth knowing:

- **`users.email` has no unique index.** Uniqueness is enforced in
  `src/users/user.service.js` inside a transaction. That narrows but does not
  close the race — two concurrent inserts can still both win. Adding a unique
  index is the real fix, and needs schema ownership.
- **`bigint` and `numeric` are returned as JSON strings** (`src/db/pool.js`), so
  `products.id` and `products.rating` keep full precision. A JS `number` cannot
  represent the whole `int8` range and would corrupt `numeric`.

## API

| Method  | Path                       | Notes                                       |
| ------- | -------------------------- | ------------------------------------------- |
| `GET`   | `/`                        | service metadata and endpoint list          |
| `GET`   | `/healthz`                 | liveness; never touches the database        |
| `GET`   | `/readyz`                  | readiness; `503` when the database is down  |
| `GET`   | `/api/products`            | filter, sort, paginate                      |
| `GET`   | `/api/products/categories` | categories with counts and price range      |
| `GET`   | `/api/products/:id`        | `id` is a bigint string                     |
| `GET`   | `/api/users`               | `q` searches email and name                 |
| `POST`  | `/api/users`               | `{ email, name }`                           |
| `GET`   | `/api/users/:id`           | uuid                                        |
| `PATCH` | `/api/users/:id`           | `{ email?, name? }`                         |
| `POST`  | `/api/auth/login`          | `{ username, password }` vs `user_password` |
| `GET`   | `/api/dashboard/summary`   | `from`, `to` (ISO, optional), `recent`      |
| `GET`   | `/api/dashboard/trend`     | `days` (1–90): approved per Bangkok day     |
| `GET`   | `/api/dashboard/alerts`    | queue counts + low-balance shops            |
| `GET`   | `/api/console/:resource`   | paged list + per-status counts (see below)  |

`GET /api/products` accepts `q`, `category`, `location`, `minPrice`,
`maxPrice`, `minRating`, `sort` (`created_at` \| `price` \| `rating` \|
`sold_count` \| `name`), `order` (`asc` \| `desc`), `limit` (1–100, default 20),
`offset`. `sort` and `order` are zod enums because they are interpolated into
`ORDER BY`; every other filter is a bound parameter.

```bash
curl 'http://localhost:3001/api/products?category=Electronics&sort=price&order=asc&limit=3'
curl -X POST http://localhost:3001/api/users \
  -H 'content-type: application/json' \
  -d '{"email":"a@example.com","name":"Ada"}'
```

`/api/console/:resource` serves a fixed registry (`src/console/console.registry.js`):
payments, outflows, withdrawals, merchants, accounts, users, roles, audit,
channels, events, devices, webhooks, alerts, settings, p2p, double-credits.
Common params: `q`, `from`, `to` (ISO), `limit`, `offset`; each resource
whitelists its own filters (e.g. `status`, `merchantId`). Unknown filters are a
`400`; SQL fragments come only from the registry and values are always bound.

List responses are `{ data: [...], pagination: { total, limit, offset } }`.
`total` comes from a `count(*) OVER ()` window in the same query, so paging
costs one round trip rather than two.

### Merchant API v1 (`/api/v1`, `X-API-Key`)

Documented in the console at **/api-docs** (the Next app proxies `/api/v1/*`
and `/api/auth/login` on its own host). Payments (QR PromptPay, slip create /
verify), public checkout data, transactions, payouts (Idempotency-Key, bulk),
withdrawal requests, receiving accounts, webhooks, balance, profile, dashboard.
Settings drive it: minimum deposit / withdrawal, minimum balance, order TTL,
unique-satang amounts, central receiving accounts and slip providers
(EasySlip / SlipOK verified for real; others fall back to manual review).

### Console write APIs (`/api/console/*`, console key)

`payments`, `outflows`, `withdrawals`, `p2p`, `double-credits`, `merchants`,
`webhooks`, `channels`, `events`, `devices`, `alert-bots`, `roles-admin`,
`users-admin`, `accounts-admin`, `profile/:id` (own info, password, 2FA),
`config` (settings page, assets, provider test, quota), `portal/:merchantId`
(Merchant Portal on behalf of a signed-in shop user). Every write locks the
row, checks the transition and writes `audit_logs`.

Errors are uniform:

```json
{
  "error": {
    "code": "validation_error",
    "message": "...",
    "details": [{ "path": "email", "message": "..." }]
  }
}
```

`code` is stable and machine-readable: `validation_error`, `invalid_json`,
`not_found`, `conflict`, `unique_violation`, `foreign_key_violation`,
`constraint_violation`, `internal_error`. Stack traces appear only for `5xx`
outside production.

## Testing

```bash
npm test           # read-only suite (26 tests)
npm run test:writes # adds 3 write-path tests
```

The suite runs against the real database, so **the default run is read-only** —
it asserts against existing rows and never writes. Write-path tests are gated
behind `TEST_ALLOW_WRITES=true`; they insert users at `@example.test` and delete
them in `after()`. Verified: `users` was 0 rows before and after.

## Layout

```
src/
  config.js            zod-validated env
  logger.js            pino; redacts auth headers, cookies, passwords
  app.js               middleware + route wiring
  server.js            listen, startup DB probe, graceful shutdown
  errors.js            AppError -> HTTP status mapping
  db/pool.js           pg Pool, query/withTransaction helpers, type parsers
  middleware/          errorHandler, asyncHandler
  users/               schema (zod) | repository (SQL) | service (rules)
  products/            schema (zod) | repository (SQL) | service (rules)
  routes/              health, users, products
scripts/
  migrate.js           forward-only, checksummed, transactional runner
  db-check.js          connectivity + schema smoke test
```

Each domain is three files: `*.schema.js` validates input at the edge,
`*.repository.js` owns SQL and column aliasing, `*.service.js` holds rules and
transactions. Routes stay thin — parse, delegate, serialise.

## Operations

`SIGTERM`/`SIGINT` stop the listener, drain the pool, and exit, with a 10s
force-exit backstop. If the database is unreachable at boot the process still
starts and reports `503` on `/readyz`, so a slow database does not become a
crash loop.

`helmet` sets security headers; `cors` is currently open (`*`) and should be
restricted to known origins before this is exposed publicly.

### Docker

The image listens on **4650** (`ENV PORT=4650`, `EXPOSE 4650`) -- deployment
port, distinct from the local dev port of 3001.

```bash
docker build -t superpayment .
docker run -p 4650:4650 -e DATABASE_URL='postgres://...' superpayment
curl http://localhost:4650/healthz
```

Override the port if your platform assigns one:

```bash
docker run -p 8080:8080 -e PORT=8080 -e DATABASE_URL='postgres://...' superpayment
```

No `.env` is baked into the image (`.dockerignore` excludes it) and no
credentials are in any layer -- inject `DATABASE_URL` at run time. Because the
image sets `NODE_ENV=production`, the real environment always wins over any
`.env` that might be mounted in.

The `HEALTHCHECK` polls `/healthz`, which is liveness-only and never touches
the database, so a database outage will not get the container killed; point
your orchestrator's readiness probe at `/readyz` instead. `node` runs as PID 1
under the exec-form `CMD`, so `docker stop` delivers `SIGTERM` straight to it
and the pool drains before exit.

## Known gaps

- **No authentication or authorisation.** Every endpoint is public. `user_password`
  stores values in a plaintext `varchar` (`myuser`/`mypassword`) — it is
  pre-existing and untouched here, but anything built on it should move to a
  hashed scheme (argon2/bcrypt) and must not be exposed through this API.
- **No rate limiting** — including `POST /api/auth/login`, which is brute-forceable. Add `express-rate-limit` before public exposure.
- **`cors` allows all origins.**
- **`users.email` uniqueness is advisory** (see [Database](#database)).
