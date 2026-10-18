import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { visible } from './private-records.js';

/**
 * Soft delete (18 Oct 2026, requested): a console "ลบ" never removes a row. It sets deleted_at / deleted_by /
 * delete_reason (migration 061); the row disappears from the console lists and shows on รายการที่ลบแล้ว (/deleted),
 * where Super Admin can restore it. A reason is required for every delete.
 */
export const deleteBodySchema = z.object({ reason: z.string().trim().min(3, 'กรุณาระบุเหตุผลที่ลบ (อย่างน้อย 3 ตัวอักษร)').max(300) });
export const reasonOf = (body) => deleteBodySchema.parse(body ?? {}).reason;

/** SET clause shared by every soft delete: $2 = actor, $3 = reason. */
export const MARK_DELETED = 'deleted_at = now(), deleted_by = $2, delete_reason = $3';

const money = (sql) => `'฿' || to_char(${sql}, 'FM999,999,999,990.00')`;

/**
 * Every deletable kind: its table, key column, a one-line title and a short detail for the list, the audit entity,
 * and what restoring does NOT switch back on (shown to the operator).
 */
export const DELETED_TYPES = {
  payment: {
    label: 'รายการชำระเงิน', table: 'payments x LEFT JOIN merchants m ON m.id = x.merchant_id', key: 'x.ref', keyType: 'text', entity: 'payment',
    title: `x.ref || ' · ' || ${money('x.amount')}`, detail: `coalesce(m.name, '—') || ' · ' || coalesce(x.customer_name, '—') || ' · สถานะ ' || x.status`,
    note: 'กู้คืนแล้วรายการกลับมาแสดงตามสถานะเดิม (ปฏิเสธ)',
  },
  outflow: {
    label: 'รายการเงินออก', table: 'outflows x LEFT JOIN merchants m ON m.id = x.merchant_id', key: 'x.ref', keyType: 'text', entity: 'outflow',
    title: `x.ref || ' · ' || ${money('x.amount')}`, detail: `coalesce(m.name, '—') || ' · ' || coalesce(x.receiver_name, '—') || ' · สถานะ ' || x.status`,
    note: 'กู้คืนแล้วรายการกลับมาแสดงตามสถานะเดิม (ปฏิเสธ)',
  },
  merchant: {
    label: 'ร้านค้า', table: 'merchants x', key: 'x.id', keyType: 'int', entity: 'merchant',
    title: 'x.name', detail: `'slug ' || x.slug || ' · สถานะ ' || x.status`,
    note: 'ร้านยังถูกระงับ (suspended) และ webhook ยังปิดอยู่ — เปิดใช้งานเองที่หน้า Merchants',
  },
  account: {
    label: 'บัญชีธนาคาร', table: 'bank_accounts x', key: 'x.id', keyType: 'int', entity: 'account',
    title: 'x.label', detail: `coalesce(x.account_name, '—') || ' · สถานะ ' || x.status`,
    note: 'บัญชียังปิดใช้งานอยู่ — เปิดใช้งานเองที่หน้าบัญชีธนาคาร',
  },
  channel: {
    label: 'ช่องทางรับข้อมูล', table: 'channels x', key: 'x.id', keyType: 'int', entity: 'channel',
    title: 'x.name', detail: `x.channel_type || ' · สถานะ ' || x.status`,
    note: 'ช่องทางยังปิดอยู่ — เปิดใช้งานเองที่หน้าช่องทางรับข้อมูล',
  },
  device: {
    label: 'อุปกรณ์ Forwarder', table: 'forwarder_devices x', key: 'x.id', keyType: 'int', entity: 'device',
    title: 'x.name', detail: `x.device_uid || ' · ' || coalesce(x.model, '—')`,
    note: 'อุปกรณ์ยังถูกระงับ — กด "เปิดใช้" เองที่หน้าอุปกรณ์',
  },
  alert: {
    label: 'Bot แจ้งเตือน Telegram', table: 'alert_channels x', key: 'x.id', keyType: 'int', entity: 'setting',
    title: 'x.name', detail: `'chat ' || coalesce(x.chat_ids, '—')`,
    note: 'bot ยังปิดอยู่ — เปิดเองที่หน้าแจ้งเตือน Telegram',
  },
  announcement: {
    label: 'ประชาสัมพันธ์', table: 'announcements x', key: 'x.id', keyType: 'int', entity: 'setting',
    title: 'x.title', detail: `'โหมด ' || x.mode`,
    note: 'ประกาศยังปิดอยู่ — เปิดเองที่หน้าประชาสัมพันธ์',
  },
  faq: {
    label: 'คำถาม Support Bot', table: 'support_faqs x', key: 'x.id', keyType: 'int', entity: 'setting',
    title: 'x.question', detail: `left(x.answer, 80)`,
    note: 'คำถามยังปิดอยู่ — เปิดเองที่หน้า Support Bot',
  },
  asset: {
    label: 'ไฟล์ (โลโก้ / ไอคอน / เสียง)', table: 'console_assets x', key: 'x.id', keyType: 'text', entity: 'setting',
    title: `x.kind || ': ' || x.name`, detail: `x.mime || ' · ' || pg_size_pretty(octet_length(x.data)::bigint)`,
    note: 'ไฟล์กลับมาในระบบ — ตั้งให้ใช้งานเองที่หน้าตั้งค่า',
  },
};

const HIDE = { payment: () => visible('payment', 'x.ref'), outflow: () => visible('outflow', 'x.ref'), account: () => visible('account', 'x.id') };

export const deletedQuerySchema = z.object({
  type: z.enum(Object.keys(DELETED_TYPES)).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const restoreParamSchema = z.object({ type: z.enum(Object.keys(DELETED_TYPES)), key: z.string().trim().min(1).max(100) });

/** Deleted rows of one or all kinds, newest deletion first. */
export async function listDeleted({ type, q, limit = 200 } = {}) {
  const kinds = type ? [type] : Object.keys(DELETED_TYPES);
  const parts = await Promise.all(kinds.map(async (k) => {
    const t = DELETED_TYPES[k];
    const { rows } = await query(
      `SELECT $1::text AS type, ${t.key}::text AS key, ${t.title} AS title, ${t.detail} AS detail,
              x.deleted_at AS "deletedAt", x.deleted_by AS "deletedBy", x.delete_reason AS "deleteReason"
         FROM ${t.table}
        WHERE x.deleted_at IS NOT NULL AND ${HIDE[k]?.() ?? 'true'}
          AND ($2::text IS NULL OR ${t.key}::text ILIKE $2 OR ${t.title} ILIKE $2 OR x.delete_reason ILIKE $2 OR x.deleted_by ILIKE $2)
        ORDER BY x.deleted_at DESC LIMIT $3`,
      [k, q ? `%${q}%` : null, limit],
    );
    return rows.map((r) => ({ ...r, typeLabel: t.label, restoreNote: t.note }));
  }));
  const data = parts.flat().sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)).slice(0, limit);
  const counts = Object.fromEntries(kinds.map((k, i) => [k, parts[i].length]));
  return { data, counts, types: Object.fromEntries(Object.entries(DELETED_TYPES).map(([k, t]) => [k, t.label])) };
}

/** Super Admin: bring a deleted row back (it reappears in its list; anything switched off on delete stays off). */
export function restoreDeleted(type, key, actor) {
  const t = DELETED_TYPES[type];
  if (!t) throw new BadRequestError(`Unknown type ${type}`);
  if (t.keyType === 'int' && !/^\d+$/.test(key)) throw new BadRequestError('รหัสไม่ถูกต้อง');
  const table = t.table.split(' ')[0];
  const keyCol = t.key.replace(/^x\./, '');
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `UPDATE ${table} x SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
        WHERE x.${keyCol}::text = $1 AND x.deleted_at IS NOT NULL
        RETURNING ${t.key}::text AS key, ${t.table.includes('JOIN') ? `x.${keyCol}::text` : t.title} AS title`,
      [key],
    );
    if (!rows[0]) throw new NotFoundError('ไม่พบรายการที่ลบไว้นี้ (อาจกู้คืนไปแล้ว)');
    await c.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, $3, $4, $5)`,
      [actor ?? 'console', `${type}.restore`, t.entity, rows[0].key, `กู้คืน${t.label}: ${rows[0].title} · ${t.note}`]);
    return { restored: rows[0].key, note: t.note };
  });
}
