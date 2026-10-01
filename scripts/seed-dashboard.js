#!/usr/bin/env node
/**
 * Seeds the payment-console tables (migration 002) with 60 days of test data
 * ending "now". Deterministic: a fixed PRNG seed, anchored to today's
 * Asia/Bangkok midnight, so re-running on the same day yields the same rows.
 *
 * Re-runnable: it empties ONLY its own five tables (banks, merchants,
 * bank_accounts, payments, outflows) and refills them in one transaction.
 * Nothing else in the shared database is read or written.
 *
 * Usage: npm run seed:dashboard
 */
import { withTransaction, closePool } from '../src/db/pool.js';
import config from '../src/config.js';
import { CONSOLE_TABLES, seedConsole } from './seed-console-data.js';

if (config.env === 'production' && process.env.SEED_ALLOW !== 'true') {
  console.error('Refusing to seed in production. Set SEED_ALLOW=true to override.');
  process.exit(1);
}

const BANKS = [
  ['KBANK', 'ธนาคารกสิกรไทย', '#138f2d'],
  ['SCB', 'ธนาคารไทยพาณิชย์', '#4e2a84'],
  ['BBL', 'ธนาคารกรุงเทพ', '#1e4291'],
  ['KTB', 'ธนาคารกรุงไทย', '#1ba5e1'],
  ['TTB', 'ธนาคารทหารไทยธนชาต', '#1279be'],
  ['BAY', 'ธนาคารกรุงศรีอยุธยา', '#fec43b'],
];

// [id, name, slug, fee %, flat fee, status, opening balance, minimum balance]
const MERCHANTS = [
  [1, 'ร้านกาแฟดอยช้าง', 'doi-coffee', 1.5, 0, 'active', 250000, 50000],
  [2, 'Bangkok Gadget', 'bkk-gadget', 2, 5, 'active', 250000, 400000],
  [3, 'ร้านผ้าไหมสุรินทร์', 'surin-silk', 1.8, 0, 'active', 250000, 50000],
  [4, 'FitLife Gym', 'fitlife', 2.5, 10, 'active', 250000, 300000],
  [5, 'Siam Books', 'siam-books', 1.2, 0, 'suspended', 250000, 0],
];

// [id, label, bank, type, status, holder name, account number]
const ACCOUNTS = [
  [1, 'KBANK ···4821', 'KBANK', 'receive', 'active', 'บจก. สยามเพย์ เซอร์วิส', '0381954821'],
  [2, 'SCB ···1093', 'SCB', 'both', 'active', 'หจก. รุ่งเรืองการค้า', '4072251093'],
  [3, 'BBL ···7730', 'BBL', 'receive', 'active', 'บจก. ทองคำ ดิจิทัล', '1196027730'],
  [4, 'KTB ···5512', 'KTB', 'send', 'active', 'บจก. สยามเพย์ เซอร์วิส', '6620485512'],
  [5, 'TTB ···2208', 'TTB', 'receive', 'inactive', 'หจก. รุ่งเรืองการค้า', '2391762208'],
];

const FIRST = ['สมศักดิ์', 'วิภา', 'ณัฐพล', 'กมลวรรณ', 'ธีรวัฒน์', 'ปิยะนุช', 'อนันต์', 'สุดารัตน์', 'John', 'Mei'];
const LAST = ['ศรีสุข', 'วงศ์ใหญ่', 'แก้วมณี', 'พรหมมา', 'Smith', 'Chen', 'บุญมา', 'ทองดี'];

const DAY = 86_400_000;
const BKK_OFFSET = 7 * 3_600_000;
const DAYS = 60;

// mulberry32 — small, fast, deterministic.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
function weighted(r, table) {
  let x = r() * table.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of table) if ((x -= w) < 0) return v;
  return table[0][0];
}
const round2 = (n) => Math.round(n * 100) / 100;

function generate(now) {
  const r = rng(20261001);
  const today = Math.floor((now + BKK_OFFSET) / DAY) * DAY - BKK_OFFSET;
  const receiving = ACCOUNTS.filter((a) => a[3] !== 'send');
  const payments = [];
  const outflows = [];

  for (let d = DAYS - 1; d >= 0; d--) {
    const dayStart = today - d * DAY;
    const dayPayments = [];
    const dayOutflows = [];

    const perDay = 6 + Math.floor(r() * 14);
    for (let i = 0; i < perDay; i++) {
      const createdAt = dayStart + Math.floor(r() * DAY);
      const merchant = r() < 0.85 ? pick(r, MERCHANTS) : null;
      const amount = round2(100 + r() * r() * 9_900);
      const status =
        d === 0 && r() < 0.35
          ? 'pending'
          : weighted(r, [['approved', 78], ['rejected', 7], ['refunded', 3], ['expired', 6], ['pending', 2]]);
      const account = pick(r, receiving);
      dayPayments.push({
        merchantId: merchant?.[0] ?? null,
        customer: `${pick(r, FIRST)} ${pick(r, LAST)}`,
        payerBank: pick(r, BANKS)[0],
        accountId: account[0],
        amount,
        fee: merchant ? Math.round((amount * merchant[3]) / 100 + merchant[4]) : 0,
        status,
        createdAt,
      });
      // Extra per-payment fields (migration 005).
      const p = dayPayments[dayPayments.length - 1];
      p.payerMasked = `••••••${String(Math.floor(r() * 10000)).padStart(4, '0')}`;
      p.commission = round2(p.fee * 0.05);
    }

    const outPerDay = Math.floor(r() * 4);
    for (let i = 0; i < outPerDay; i++) {
      const createdAt = dayStart + Math.floor(r() * DAY);
      const merchant = pick(r, MERCHANTS);
      dayOutflows.push({
        merchantId: merchant[0],
        category: weighted(r, [['other', 6], ['transfer', 3], ['expense', 1], ['refund', 1]]),
        accountId: r() < 0.5 ? 4 : 2, // KTB send / SCB both
        receiverName: merchant[1],
        receiverBank: pick(r, BANKS)[0],
        receiverAccount: `${Math.floor(100 + r() * 899)}-${Math.floor(1 + r() * 8)}-${Math.floor(10000 + r() * 89999)}-${Math.floor(r() * 9)}`,
        amount: round2(2_000 + r() * 30_000),
        status: d === 0 && r() < 0.5 ? 'pending' : weighted(r, [['approved', 9], ['rejected', 1]]),
        createdAt,
      });
    }

    // Rows "later today" than now are dropped only after generation, so the
    // random sequence never depends on the time the script runs.
    const byTime = (a, b) => a.createdAt - b.createdAt;
    dayPayments.sort(byTime).forEach((p) => p.createdAt <= now && payments.push(p));
    dayOutflows.sort(byTime).forEach((o) => o.createdAt <= now && outflows.push(o));
  }
  // One running number per kind, oldest first: TXN172801, TXN172802, … / OUT40101, …
  payments.forEach((p, i) => (p.ref = `TXN${172801 + i}`));
  outflows.forEach((o, i) => (o.ref = `OUT${40101 + i}`));
  return { payments, outflows };
}

/** Multi-row INSERT with numbered placeholders. */
async function insertRows(client, table, columns, rows) {
  if (rows.length === 0) return;
  const params = [];
  const tuples = rows.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`);
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
}

const now = Date.now();
const { payments, outflows } = generate(now);
let consoleCounts = {};

try {
  await withTransaction(async (client) => {
    // Only this script's own tables. No CASCADE: if some other table ever
    // references these, the truncate fails instead of silently emptying it.
    await client.query(`TRUNCATE ${CONSOLE_TABLES.join(', ')}, outflows, payments, bank_accounts, merchants, banks RESTART IDENTITY`);

    await insertRows(client, 'banks', ['code', 'name', 'color'], BANKS);
    await insertRows(client, 'merchants', ['id', 'name', 'slug', 'fee_percent', 'fee_flat', 'status', 'opening_balance', 'min_balance'], MERCHANTS);
    await insertRows(client, 'bank_accounts', ['id', 'label', 'bank_code', 'account_type', 'status', 'account_name', 'account_no'], ACCOUNTS);
    // Explicit ids above, so move the sequences past them.
    await client.query(`SELECT setval('merchants_id_seq', (SELECT max(id) FROM merchants))`);
    await client.query(`SELECT setval('bank_accounts_id_seq', (SELECT max(id) FROM bank_accounts))`);

    await insertRows(
      client,
      'payments',
      ['ref', 'merchant_id', 'customer_name', 'payer_bank_code', 'payer_account_masked', 'bank_account_id', 'amount', 'fee', 'commission', 'status', 'created_at'],
      payments.map((p) => [p.ref, p.merchantId, p.customer, p.payerBank, p.payerMasked, p.accountId, p.amount, p.fee, p.commission, p.status, new Date(p.createdAt)]),
    );
    await insertRows(
      client,
      'outflows',
      ['ref', 'merchant_id', 'category', 'bank_account_id', 'receiver_name', 'receiver_bank_code', 'receiver_account', 'amount', 'status', 'created_at'],
      outflows.map((o) => [o.ref, o.merchantId, o.category, o.accountId, o.receiverName, o.receiverBank, o.receiverAccount, o.amount, o.status, new Date(o.createdAt)]),
    );

    consoleCounts = await seedConsole(client, now);
  });

  console.log(
    `seeded banks=${BANKS.length} merchants=${MERCHANTS.length} bank_accounts=${ACCOUNTS.length} ` +
      `payments=${payments.length} outflows=${outflows.length} (60 days ending ${new Date(now).toISOString()})`,
  );
  console.log('console tables:', Object.entries(consoleCounts).map(([t, n]) => `${t}=${n}`).join(' '));
} catch (err) {
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
