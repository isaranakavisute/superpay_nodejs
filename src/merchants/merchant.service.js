import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../shared/password.js';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { seal } from '../shared/secret-box.js';

const money = z.coerce.number().min(0).max(100_000_000).multipleOf(0.01);
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const subIdParamSchema = z.object({ id: z.coerce.number().int().positive(), subId: z.coerce.number().int().positive() });

const fields = {
  name: z.string().trim().min(1).max(120),
  feePercent: z.coerce.number().min(0).max(100).multipleOf(0.01),
  feeFlat: money,
  minBalance: money,
  status: z.enum(['active', 'suspended']),
  kycStatus: z.enum(['pending', 'verified', 'rejected']),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
  contactPhone: z.string().trim().max(40).optional(),
};
export const createBodySchema = z.object({
  ...fields,
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'slug: a–z, 0–9 and dashes'),
  openingBalance: money.default(0),
});
export const updateBodySchema = z.object(fields);
export const creditBodySchema = z.object({
  amount: z.coerce.number().refine((n) => n !== 0, 'amount must not be 0').refine((n) => Math.abs(n) <= 100_000_000, 'too large'),
  reason: z.string().trim().min(1).max(300),
});
export const keyBodySchema = z.object({ label: z.string().trim().min(1).max(60) });
export const webhookBodySchema = z.object({ url: z.string().trim().url().max(500).refine((u) => /^https:\/\//.test(u), 'webhook URL must be https') });
export const portalUserBodySchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,60}$/, 'username: a–z, 0–9, . _ -'),
  fullName: z.string().trim().min(1).max(120),
  tier: z.enum(['owner', 'staff', 'viewer']),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal('')),
  password: z.string().min(8).max(100).optional().or(z.literal('')),
});

const sha = (v) => createHash('sha256').update(v).digest('hex');
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'merchant', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lock(client, id) {
  const { rows } = await client.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new NotFoundError(`Merchant ${id} does not exist`);
  return rows[0];
}

/** Live balance: opening + approved (amount − fee) − approved outflows + credit adjustments. */
async function balanceOf(client, id) {
  const { rows } = await client.query(
    `SELECT m.opening_balance
          + coalesce((SELECT sum(amount - fee) FROM payments WHERE merchant_id = m.id AND status = 'approved'), 0)
          - coalesce((SELECT sum(amount) FROM outflows WHERE merchant_id = m.id AND status = 'approved'), 0)
          + coalesce((SELECT sum(amount) FROM merchant_credit_adjustments WHERE merchant_id = m.id), 0) AS balance
       FROM merchants m WHERE m.id = $1`,
    [id],
  );
  return Number(rows[0].balance);
}

export function create(actor, b) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO merchants (name, slug, fee_percent, fee_flat, min_balance, opening_balance, status, kyc_status, contact_email, contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, nullif($9, ''), nullif($10, '')) RETURNING id`,
      [b.name, b.slug, b.feePercent, b.feeFlat, b.minBalance, b.openingBalance, b.status, b.kycStatus, b.contactEmail ?? '', b.contactPhone ?? ''],
    );
    await audit(client, actor, 'merchant.create', b.slug, `เพิ่มร้าน ${b.name}`);
    return { id: rows[0].id };
  });
}

export function update(id, actor, b) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    await client.query(
      `UPDATE merchants SET name = $2, fee_percent = $3, fee_flat = $4, min_balance = $5, status = $6, kyc_status = $7,
              contact_email = nullif($8, ''), contact_phone = nullif($9, '') WHERE id = $1`,
      [id, b.name, b.feePercent, b.feeFlat, b.minBalance, b.status, b.kycStatus, b.contactEmail ?? '', b.contactPhone ?? ''],
    );
    const changes = [m.status !== b.status && `สถานะ: ${m.status} → ${b.status}`, Number(m.fee_percent) !== b.feePercent && `ค่าธรรมเนียม ${m.fee_percent}% → ${b.feePercent}%`].filter(Boolean);
    await audit(client, actor, 'merchant.update', m.slug, changes.join(' · ') || 'แก้ไขข้อมูลร้าน');
  });
}

export function remove(id, actor) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const { rows } = await client.query(
      `SELECT (SELECT count(*) FROM payments WHERE merchant_id = $1) + (SELECT count(*) FROM outflows WHERE merchant_id = $1)
            + (SELECT count(*) FROM withdrawal_requests WHERE merchant_id = $1) AS n`,
      [id],
    );
    if (Number(rows[0].n) > 0) throw new ConflictError(`${m.name} has transactions — suspend it instead of deleting`);
    await client.query('DELETE FROM webhook_endpoints WHERE merchant_id = $1', [id]);
    await client.query('DELETE FROM merchants WHERE id = $1', [id]);
    await audit(client, actor, 'merchant.delete', m.slug, `ลบร้าน ${m.name}`);
  });
}

export function adjustCredit(id, actor, { amount, reason }) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const after = (await balanceOf(client, id)) + amount;
    await client.query(
      `INSERT INTO merchant_credit_adjustments (merchant_id, amount, reason, balance_after, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, amount, reason, after, actor],
    );
    await audit(client, actor, 'merchant.credit', m.slug, `${amount > 0 ? 'เพิ่ม' : 'ลด'}เครดิต ${fmt(Math.abs(amount))} บาท — ${reason}`);
    return { balanceAfter: after.toFixed(2) };
  });
}

export async function credits(id) {
  const { rows } = await query(
    `SELECT id, amount, reason, balance_after AS "balanceAfter", created_by AS "createdBy", created_at AS "createdAt"
       FROM merchant_credit_adjustments WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [id],
  );
  return { balance: (await balanceOf({ query }, id)).toFixed(2), items: rows };
}

export async function apiKeys(id) {
  const { rows } = await query(
    `SELECT id, label, key_prefix AS "keyPrefix", status, last_used_at AS "lastUsedAt", created_by AS "createdBy", created_at AS "createdAt"
       FROM merchant_api_keys WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  return rows;
}

/** Returns the full key and its signing secret once; the key is stored hashed, the secret sealed. */
export function createKey(id, actor, { label }) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const raw = `ak_live_${randomBytes(24).toString('base64url')}`;
    // Shop-level keys sign their requests with their own secret (shown once, stored sealed).
    const signingSecret = `ss_live_${randomBytes(32).toString('base64url')}`;
    await client.query(`INSERT INTO merchant_api_keys (merchant_id, label, key_prefix, key_hash, created_by, signing_secret_sealed) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id, label, `${raw.slice(0, 14)}…`, sha(raw), actor, seal(signingSecret),
    ]);
    await audit(client, actor, 'apikey.create', m.slug, `ออก API key "${label}" + signing secret`);
    return { key: raw, signingSecret };
  });
}

export function revokeKey(id, keyId, actor) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const { rowCount } = await client.query(`UPDATE merchant_api_keys SET status = 'revoked' WHERE id = $1 AND merchant_id = $2 AND status = 'active'`, [keyId, id]);
    if (!rowCount) throw new ConflictError('Key not found or already revoked');
    await audit(client, actor, 'apikey.revoke', m.slug, `เพิกถอน API key #${keyId}`);
  });
}

export async function webhook(id) {
  const { rows } = await query(
    `SELECT id, url, events, status, secret_prefix AS "secretPrefix", rotated_at AS "rotatedAt" FROM webhook_endpoints WHERE merchant_id = $1 ORDER BY id LIMIT 1`,
    [id],
  );
  const { rows: deliveries } = await query(
    `SELECT d.id, d.event, d.payment_ref AS "paymentRef", d.status_code AS "statusCode", d.attempts, d.response_ms AS "responseMs", d.error, d.delivered_at AS "deliveredAt"
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE e.merchant_id = $1 ORDER BY d.delivered_at DESC LIMIT 20`,
    [id],
  );
  return { endpoint: rows[0] ?? null, deliveries };
}

export function setWebhook(id, actor, { url }) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const { rowCount } = await client.query(`UPDATE webhook_endpoints SET url = $2, status = 'active' WHERE merchant_id = $1`, [id, url]);
    if (!rowCount) {
      await client.query(`INSERT INTO webhook_endpoints (merchant_id, url, events) VALUES ($1, $2, ARRAY['payment.approved', 'payment.rejected', 'withdrawal.approved'])`, [id, url]);
    }
    await audit(client, actor, 'merchant.webhook', m.slug, `ตั้ง webhook → ${url}`);
  });
}

/** New signing secret, shown once. */
export function rotateSecret(id, actor) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const raw = `whsec_${randomBytes(24).toString('base64url')}`;
    const { rowCount } = await client.query(
      `UPDATE webhook_endpoints SET secret_prefix = $2, secret_hash = $3, secret_enc = $4, rotated_at = now() WHERE merchant_id = $1`,
      [id, `${raw.slice(0, 12)}…`, sha(raw), seal(raw)],
    );
    if (!rowCount) throw new BadRequestError('Set a webhook URL first');
    await audit(client, actor, 'merchant.webhook_secret', m.slug, 'หมุน webhook secret');
    return { secret: raw };
  });
}

export async function portalUsers(id) {
  const { rows } = await query(
    `SELECT id, username, full_name AS "fullName", tier, status, email, (password_hash IS NOT NULL) AS "canApiLogin", last_login_at AS "lastLoginAt", created_at AS "createdAt"
       FROM merchant_portal_users WHERE merchant_id = $1 ORDER BY tier, id`,
    [id],
  );
  return rows;
}

/** Portal user; with email + password they can also sign in to the merchant API (POST /api/auth/login). */
export function addPortalUser(id, actor, { username, fullName, tier, email, password }) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const hash = password ? await hashPassword(password) : null;
    await client.query(`INSERT INTO merchant_portal_users (merchant_id, username, full_name, tier, email, password_hash) VALUES ($1, $2, $3, $4, nullif($5, ''), $6)`, [
      id, username, fullName, tier, email ?? '', hash,
    ]);
    await audit(client, actor, 'merchant.portal_user', m.slug, `เพิ่มผู้ใช้ portal ${username} (${tier})`);
  });
}

export function togglePortalUser(id, userId, actor) {
  return withTransaction(async (client) => {
    const m = await lock(client, id);
    const { rows } = await client.query(
      `UPDATE merchant_portal_users SET status = CASE status WHEN 'active' THEN 'disabled' ELSE 'active' END
        WHERE id = $1 AND merchant_id = $2 RETURNING username, status`,
      [userId, id],
    );
    if (!rows[0]) throw new NotFoundError('Portal user not found');
    await audit(client, actor, 'merchant.portal_user', m.slug, `${rows[0].username}: ${rows[0].status}`);
    return { status: rows[0].status };
  });
}
