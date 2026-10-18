import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { hashPassword } from '../shared/password.js';
import { BALANCE_SQL } from '../shared/balance-sql.js';
import { MAX_DEPTH, checkRatesAgainstChildren, checkRatesAgainstParent, effectiveStatus } from './tree.js';

/**
 * Sub-merchants, managed by their parent shop in the Merchant Portal: a shop creates shops under itself
 * (each with its own owner login), sets their fees (never below its own — it keeps the difference),
 * suspends / re-activates them and resets their owner's password. A new sub-merchant waits for the
 * admin's approval (status 'pending') before it can take payments. A parent sees its whole subtree;
 * it manages only its direct children (grandchildren belong to their own parent).
 */
const err = (status, code, msg) => new AppError(msg, { status, code });
const pct = z.coerce.number().min(0).max(100).multipleOf(0.01);
const money = z.coerce.number().min(0).max(100_000_000).multipleOf(0.01);
const rates = { feePercent: pct, feeFlat: money, outFeePercent: pct, outFeeFlat: money };

export const createSubSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'slug: a–z, 0–9 และขีด - (2–41 ตัว)'),
  ...rates,
  allowSubMerchants: z.boolean().default(true),
  contactPhone: z.string().trim().max(40).optional().default(''),
  owner: z.object({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    password: z.string().min(8, 'รหัสผ่านชั่วคราวอย่างน้อย 8 ตัว').max(100),
  }),
});
export const updateSubSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ...rates,
  allowSubMerchants: z.boolean(),
  status: z.enum(['active', 'suspended']),
});
export const resetOwnerSchema = z.object({ password: z.string().min(8, 'รหัสผ่านชั่วคราวอย่างน้อย 8 ตัว').max(100) });

const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audit = (c, actor, action, ref, detail) =>
  c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'merchant', $3, $4)`, [actor, action, ref, detail]);
const ratesOf = (b) => ({ feePercent: b.feePercent, feeFlat: b.feeFlat, outFeePercent: b.outFeePercent, outFeeFlat: b.outFeeFlat });

/** Everything below `home`, root-first order, with balance, sales and the commission `home` earned from each. */
export async function subtree(home) {
  const { rows } = await query(
    `SELECT m.id, m.name, m.slug, m.parent_id AS "parentId", cardinality(m.path) - $2 AS depth, m.status, m.kyc_status AS "kycStatus",
            m.fee_percent AS "feePercent", m.fee_flat AS "feeFlat", m.out_fee_percent AS "outFeePercent", m.out_fee_flat AS "outFeeFlat",
            m.allow_sub_merchants AS "allowSubMerchants", m.approved_at AS "approvedAt", m.created_at AS "createdAt", m.contact_phone AS "contactPhone",
            ${BALANCE_SQL} AS balance,
            (SELECT count(*)::int FROM payments WHERE merchant_id = m.id AND status = 'approved') AS "paidCount",
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE merchant_id = m.id AND status = 'approved') AS "paidTotal",
            (SELECT coalesce(sum(s.amount), 0) FROM fee_splits s
               LEFT JOIN payments p ON s.source_kind = 'payment' AND p.id = s.source_id
               LEFT JOIN outflows o ON s.source_kind = 'outflow' AND o.id = s.source_id
              WHERE s.merchant_id = $1 AND s.from_merchant_id = m.id AND (p.status = 'approved' OR o.status = 'approved')) AS "commissionToMe",
            (SELECT count(*)::int FROM merchants k WHERE k.parent_id = m.id AND k.deleted_at IS NULL) AS "childCount",
            (SELECT row_to_json(u) FROM (SELECT full_name AS "fullName", email, username FROM merchant_portal_users
               WHERE merchant_id = m.id AND tier = 'owner' AND NOT super_admin ORDER BY id LIMIT 1) u) AS owner
       FROM merchants m WHERE $1 = ANY (m.path) AND m.deleted_at IS NULL
      ORDER BY m.path || m.id`,
    [home.id, (home.path ?? []).length],
  );
  return rows;
}

async function freeUsername(c, base) {
  const stem = base.length >= 3 ? base : `${base}-owner`;
  for (let i = 0; i < 50; i++) {
    const u = i ? `${stem}.${i + 1}` : stem;
    const { rows } = await c.query('SELECT 1 FROM merchant_portal_users WHERE username = $1', [u]);
    if (!rows.length) return u;
  }
  throw err(409, 'USERNAME_TAKEN', 'สร้างชื่อผู้ใช้ไม่ได้ ลองใช้ slug อื่น');
}

export function createSub(homeId, actor, b) {
  return withTransaction(async (c) => {
    const { rows: hr } = await c.query('SELECT * FROM merchants WHERE id = $1 FOR UPDATE', [homeId]);
    const home = hr[0];
    if (!home) throw new NotFoundError('ไม่พบร้านค้า');
    if (!home.allow_sub_merchants) throw err(403, 'SUB_MERCHANTS_NOT_ALLOWED', 'ร้านนี้ไม่ได้รับอนุญาตให้สร้างร้านย่อย — ติดต่อผู้ดูแลระบบ');
    if ((await effectiveStatus(c, homeId)) !== 'active') throw err(403, 'SHOP_NOT_ACTIVE', 'ร้านต้องได้รับอนุมัติและเปิดใช้งานก่อน จึงจะสร้างร้านย่อยได้');
    if ((home.path ?? []).length + 1 > MAX_DEPTH) throw err(400, 'TOO_DEEP', `สร้างร้านย่อยได้ลึกสุด ${MAX_DEPTH} ชั้น`);
    checkRatesAgainstParent(home, ratesOf(b));
    const { rows: dupSlug } = await c.query('SELECT 1 FROM merchants WHERE slug = $1', [b.slug]);
    if (dupSlug.length) throw err(409, 'SLUG_TAKEN', `slug “${b.slug}” ถูกใช้แล้ว`);
    const { rows: dupMail } = await c.query('SELECT 1 FROM merchant_portal_users WHERE lower(email) = $1', [b.owner.email]);
    if (dupMail.length) throw err(409, 'EMAIL_TAKEN', `อีเมล ${b.owner.email} ถูกใช้กับผู้ใช้ร้านอื่นแล้ว — 1 อีเมลใช้ได้กับร้านเดียว`);
    const { rows } = await c.query(
      `INSERT INTO merchants (name, slug, fee_percent, fee_flat, out_fee_percent, out_fee_flat, min_balance, opening_balance, status, kyc_status,
                              contact_email, contact_phone, parent_id, path, allow_sub_merchants, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'pending', 'pending', $7, nullif($8, ''), $9, $10, $11, $12) RETURNING id`,
      [b.name, b.slug, b.feePercent, b.feeFlat, b.outFeePercent, b.outFeeFlat, b.owner.email, b.contactPhone ?? '', home.id, [...(home.path ?? []), home.id],
        b.allowSubMerchants, actor],
    );
    const username = await freeUsername(c, b.slug);
    await c.query(
      `INSERT INTO merchant_portal_users (merchant_id, username, full_name, tier, email, password_hash, must_change_password) VALUES ($1, $2, $3, 'owner', $4, $5, true)`,
      [rows[0].id, username, b.owner.fullName, b.owner.email, await hashPassword(b.owner.password)],
    );
    await audit(c, actor, 'merchant.sub_create', b.slug,
      `${home.name} สร้างร้านย่อย ${b.name} — เงินเข้า ${b.feePercent}% + ${fmt(b.feeFlat)} · เงินออก ${b.outFeePercent}% + ${fmt(b.outFeeFlat)} · รอผู้ดูแลอนุมัติ`);
    return { id: rows[0].id, owner: { username, email: b.owner.email } };
  });
}

/** A direct child of `homeId`, locked. */
async function childOf(c, homeId, childId) {
  const { rows } = await c.query('SELECT * FROM merchants WHERE id = $1 AND parent_id = $2 FOR UPDATE', [childId, homeId]);
  if (!rows[0]) throw err(404, 'SUB_MERCHANT_NOT_FOUND', 'ไม่พบร้านย่อยนี้ (จัดการได้เฉพาะร้านย่อยชั้นถัดไปของร้านคุณ)');
  return rows[0];
}

export function updateSub(homeId, childId, actor, b) {
  return withTransaction(async (c) => {
    const { rows: hr } = await c.query('SELECT * FROM merchants WHERE id = $1', [homeId]);
    const k = await childOf(c, homeId, childId);
    checkRatesAgainstParent(hr[0], ratesOf(b));
    await checkRatesAgainstChildren(c, k.id, ratesOf(b));
    // 'pending' waits for the admin; a parent can suspend any time, and re-activate only an approved shop.
    if (b.status === 'active' && !k.approved_at) throw err(403, 'AWAITING_APPROVAL', 'ร้านนี้รอผู้ดูแลระบบอนุมัติ — เปิดใช้งานเองไม่ได้');
    const status = k.status === 'pending' && b.status === 'active' ? 'pending' : b.status;
    await c.query(
      `UPDATE merchants SET name = $2, fee_percent = $3, fee_flat = $4, out_fee_percent = $5, out_fee_flat = $6, allow_sub_merchants = $7, status = $8 WHERE id = $1`,
      [k.id, b.name, b.feePercent, b.feeFlat, b.outFeePercent, b.outFeeFlat, b.allowSubMerchants, status],
    );
    const changes = [k.status !== status && `สถานะ ${k.status} → ${status}`,
      (Number(k.fee_percent) !== b.feePercent || Number(k.fee_flat) !== b.feeFlat) && `เงินเข้า ${Number(k.fee_percent)}% + ${fmt(k.fee_flat)} → ${b.feePercent}% + ${fmt(b.feeFlat)}`,
      (Number(k.out_fee_percent) !== b.outFeePercent || Number(k.out_fee_flat) !== b.outFeeFlat) && `เงินออก ${Number(k.out_fee_percent)}% + ${fmt(k.out_fee_flat)} → ${b.outFeePercent}% + ${fmt(b.outFeeFlat)}`,
      k.allow_sub_merchants !== b.allowSubMerchants && `สร้างร้านย่อยต่อ: ${b.allowSubMerchants ? 'อนุญาต' : 'ไม่อนุญาต'}`].filter(Boolean);
    await audit(c, actor, 'merchant.sub_update', k.slug, `${hr[0].name} แก้ร้านย่อย ${b.name}: ${changes.join(' · ') || 'ไม่เปลี่ยน'}`);
    return { success: true, status };
  });
}

export function resetOwnerPassword(homeId, childId, actor, { password }) {
  return withTransaction(async (c) => {
    const k = await childOf(c, homeId, childId);
    const { rows } = await c.query(
      `UPDATE merchant_portal_users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL
        WHERE id = (SELECT id FROM merchant_portal_users WHERE merchant_id = $1 AND tier = 'owner' ORDER BY id LIMIT 1) RETURNING username, email`,
      [k.id, await hashPassword(password)],
    );
    if (!rows[0]) throw err(404, 'OWNER_NOT_FOUND', 'ร้านย่อยนี้ยังไม่มีผู้ใช้เจ้าของร้าน');
    await audit(c, actor, 'merchant.sub_owner_password', k.slug, `ตั้งรหัสผ่านชั่วคราวใหม่ให้เจ้าของร้าน ${rows[0].username}`);
    return { success: true, owner: rows[0] };
  });
}

export const networkQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), 'days: 7, 30 หรือ 90').default(30),
  shop: z.coerce.number().int().positive().optional(),
});

/**
 * Dashboard of a shop's sub-merchants (ภาพรวมร้านย่อย): all of them together, or one (`shop`, any depth below).
 * Period figures run over the last `days` Bangkok days; balance and pending are as of now.
 */
export async function network(home, { days, shop }) {
  const depth0 = (home.path ?? []).length;
  if (shop) {
    const { rows } = await query('SELECT 1 FROM merchants WHERE id = $1 AND $2 = ANY (path)', [shop, home.id]);
    if (!rows.length) throw err(404, 'SUB_MERCHANT_NOT_FOUND', 'ไม่พบร้านย่อยนี้ใต้ร้านของคุณ');
  }
  const from = `(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - ($3::int - 1) * interval '1 day') AT TIME ZONE 'Asia/Bangkok'`;
  const { rows: shops } = await query(
    `SELECT m.id, m.name, m.slug, m.parent_id AS "parentId", cardinality(m.path) - $2 AS depth, m.status,
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE merchant_id = m.id AND status = 'approved' AND completed_at >= ${from}) AS "paidAmount",
            (SELECT count(*)::int FROM payments WHERE merchant_id = m.id AND status = 'approved' AND completed_at >= ${from}) AS "paidCount",
            (SELECT coalesce(sum(fee), 0) FROM payments WHERE merchant_id = m.id AND status = 'approved' AND completed_at >= ${from}) AS "feesPaid",
            (SELECT coalesce(sum(amount), 0) FROM outflows WHERE merchant_id = m.id AND status = 'approved' AND completed_at >= ${from}) AS "outAmount",
            (SELECT count(*)::int FROM outflows WHERE merchant_id = m.id AND status = 'approved' AND completed_at >= ${from}) AS "outCount",
            (SELECT coalesce(sum(fee), 0) FROM outflows WHERE merchant_id = m.id AND status = 'approved' AND completed_at >= ${from}) AS "outFees",
            (SELECT coalesce(sum(s.amount), 0) FROM fee_splits s
               LEFT JOIN payments p ON s.source_kind = 'payment' AND p.id = s.source_id
               LEFT JOIN outflows o ON s.source_kind = 'outflow' AND o.id = s.source_id
              WHERE s.merchant_id = $1 AND s.from_merchant_id = m.id
                AND ((p.status = 'approved' AND p.completed_at >= ${from}) OR (o.status = 'approved' AND o.completed_at >= ${from}))) AS "commissionToMe",
            ${BALANCE_SQL} AS balance,
            (SELECT count(*)::int FROM payments WHERE merchant_id = m.id AND status = 'pending' AND (expires_at IS NULL OR expires_at > now())) AS "pendingPayments",
            (SELECT coalesce(sum(amount), 0) FROM withdrawal_requests WHERE merchant_id = m.id AND status = 'pending') AS "pendingWithdrawals"
       FROM merchants m
      WHERE ${shop ? 'm.id = $4' : '$1 = ANY (m.path)'}
      ORDER BY m.path || m.id`,
    shop ? [home.id, depth0, days, shop] : [home.id, depth0, days],
  );
  const ids = shops.map((s) => s.id);
  // One row per Bangkok day: [ds, de) as timestamptz.
  const { rows: trend } = await query(
    `WITH d AS (
       SELECT g AS day, g AT TIME ZONE 'Asia/Bangkok' AS ds, (g + interval '1 day') AT TIME ZONE 'Asia/Bangkok' AS de
         FROM generate_series(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - ($2::int - 1) * interval '1 day',
                              date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok'), interval '1 day') AS g)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE merchant_id = ANY ($1) AND status = 'approved' AND completed_at >= d.ds AND completed_at < d.de) AS incoming,
            (SELECT count(*)::int FROM payments WHERE merchant_id = ANY ($1) AND status = 'approved' AND completed_at >= d.ds AND completed_at < d.de) AS count,
            (SELECT coalesce(sum(amount), 0) FROM outflows WHERE merchant_id = ANY ($1) AND status = 'approved' AND completed_at >= d.ds AND completed_at < d.de) AS outgoing,
            (SELECT coalesce(sum(s.amount), 0) FROM fee_splits s
               LEFT JOIN payments p ON s.source_kind = 'payment' AND p.id = s.source_id
               LEFT JOIN outflows o ON s.source_kind = 'outflow' AND o.id = s.source_id
              WHERE s.merchant_id = $3 AND s.from_merchant_id = ANY ($1)
                AND ((p.status = 'approved' AND p.completed_at >= d.ds AND p.completed_at < d.de)
                  OR (o.status = 'approved' AND o.completed_at >= d.ds AND o.completed_at < d.de))) AS commission
       FROM d ORDER BY d.day`,
    [ids, days, home.id],
  );
  const n = (k) => Math.round(shops.reduce((t, s) => t + Number(s[k]), 0) * 100) / 100;
  return {
    days, shop: shop ?? null,
    totals: {
      shops: shops.length, active: shops.filter((s) => s.status === 'active').length, pending: shops.filter((s) => s.status === 'pending').length,
      suspended: shops.filter((s) => s.status === 'suspended').length,
      paidAmount: n('paidAmount'), paidCount: n('paidCount'), feesPaid: n('feesPaid'), outAmount: n('outAmount'), outCount: n('outCount'), outFees: n('outFees'),
      commissionToMe: n('commissionToMe'), balance: n('balance'), pendingPayments: n('pendingPayments'), pendingWithdrawals: n('pendingWithdrawals'),
    },
    trend: trend.map((t) => ({ day: t.day, incoming: Number(t.incoming), outgoing: Number(t.outgoing), commission: Number(t.commission), count: t.count })),
    shops,
  };
}

// ---------- merchant API (/api/v1/sub-merchants) ----------

const NUM = ['feePercent', 'feeFlat', 'outFeePercent', 'outFeeFlat', 'balance', 'paidTotal', 'commissionToMe', 'paidAmount', 'feesPaid', 'outAmount', 'outFees', 'pendingWithdrawals'];
const apiRow = (r) => {
  const o = { ...r, id: String(r.id), parentId: r.parentId == null ? null : String(r.parentId), status: String(r.status).toUpperCase() };
  for (const k of NUM) if (k in o) o[k] = Number(o[k]);
  return o;
};

/** Every sub-merchant below the API key's shop (any depth). */
export async function apiList(m) {
  const rows = await subtree(m);
  return { success: true, total: rows.length, subMerchants: rows.map(apiRow) };
}

/** One sub-merchant (any depth below) with its figures over `days`. */
export async function apiOne(m, id, days) {
  const row = (await subtree(m)).find((r) => r.id === id);
  if (!row) throw err(404, 'SUB_MERCHANT_NOT_FOUND', 'ไม่พบร้านย่อยนี้ใต้ร้านของคุณ');
  const n = await network(m, { days, shop: id });
  return { success: true, subMerchant: apiRow(row), overview: { days: n.days, totals: n.totals, trend: n.trend } };
}

/** All sub-merchants together (or one with `shop`): totals, daily trend and per-shop figures. */
export async function apiOverview(m, q) {
  const n = await network(m, q);
  return { success: true, days: n.days, shop: n.shop == null ? null : String(n.shop), totals: n.totals, trend: n.trend, shops: n.shops.map(apiRow) };
}
