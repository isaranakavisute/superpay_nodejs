import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../errors.js';
import { open, seal } from '../shared/secret-box.js';
import * as totp from '../shared/totp.js';

/**
 * Self-service for the signed-in console user (the Next server passes the
 * session's user_password id). Name/email/phone and 2FA live in
 * console_user_profiles; only the password change touches user_password.
 */
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const infoBodySchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
});
export const passwordBodySchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(6).max(100) });
export const codeBodySchema = z.object({ code: z.string().trim().max(10) });
export const disableBodySchema = z.object({ password: z.string().min(1).max(200), code: z.string().trim().max(10) });

const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
const samePassword = (a, b) => timingSafeEqual(digest(a), digest(b));
const audit = (client, actor, action, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'user', $1, $3)`, [actor, action, detail]);

async function lock(client, id) {
  const { rows } = await client.query(
    `SELECT p.*, u.myuser AS username, u.mypassword AS password
       FROM console_user_profiles p JOIN user_password u ON u.id = p.user_password_id
      WHERE p.user_password_id = $1 FOR UPDATE OF p`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`User ${id} has no console profile`);
  return rows[0];
}

/** Consume a TOTP code against a sealed secret: valid, and newer than the last accepted step. */
function checkCode(u, sealed, code) {
  const step = totp.verify(open(sealed), code);
  if (step == null || (u.totp_last_step != null && step <= Number(u.totp_last_step))) throw new BadRequestError('รหัส 2FA ไม่ถูกต้องหรือหมดอายุแล้ว');
  return step;
}

export async function get(id) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    return {
      profile: {
        id, username: u.username, fullName: u.full_name, email: u.email, phone: u.phone, roleCode: u.role_code, status: u.status,
        createdAt: u.created_at, twoFactorEnabledAt: u.totp_enabled_at, passwordChangedAt: u.password_changed_at,
        permissions: (await client.query('SELECT permissions FROM console_roles WHERE code = $1', [u.role_code])).rows[0]?.permissions ?? [],
      },
    };
  });
}

export function updateInfo(id, b) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    await client.query(`UPDATE console_user_profiles SET full_name = $2, email = nullif($3, ''), phone = nullif($4, '') WHERE user_password_id = $1`, [id, b.fullName, b.email ?? '', b.phone ?? '']);
    await audit(client, u.username, 'user.profile', 'แก้ไขข้อมูลส่วนตัว');
  });
}

export function changePassword(id, b) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    if (!samePassword(u.password, b.current)) throw new BadRequestError('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    if (samePassword(u.password, b.next)) throw new BadRequestError('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
    // user_password stores plaintext by its own (pre-existing) design.
    await client.query('UPDATE user_password SET mypassword = $2 WHERE id = $1', [id, b.next]);
    await client.query('UPDATE console_user_profiles SET password_changed_at = now() WHERE user_password_id = $1', [id]);
    await audit(client, u.username, 'user.password', 'เปลี่ยนรหัสผ่าน');
  });
}

/** Start (or restart) setup: a fresh pending secret, returned once for the QR. */
export function setup2fa(id) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    if (u.totp_enabled_at) throw new ConflictError('2FA เปิดใช้งานอยู่แล้ว');
    const secret = totp.newSecret();
    await client.query('UPDATE console_user_profiles SET totp_pending = $2 WHERE user_password_id = $1', [id, seal(secret)]);
    return { secret, uri: totp.otpauthUri(secret, u.username) };
  });
}

export function enable2fa(id, { code }) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    if (u.totp_enabled_at) throw new ConflictError('2FA เปิดใช้งานอยู่แล้ว');
    if (!u.totp_pending) throw new ConflictError('กรุณาเริ่มตั้งค่า 2FA ใหม่');
    const step = checkCode(u, u.totp_pending, code);
    await client.query(
      `UPDATE console_user_profiles SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = now(), totp_last_step = $2 WHERE user_password_id = $1`,
      [id, step],
    );
    await audit(client, u.username, 'user.2fa_enable', 'เปิดใช้ 2FA');
  });
}

export function disable2fa(id, b) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    if (!u.totp_enabled_at) throw new ConflictError('2FA ยังไม่ได้เปิดใช้งาน');
    if (!samePassword(u.password, b.password)) throw new BadRequestError('รหัสผ่านไม่ถูกต้อง');
    checkCode(u, u.totp_secret, b.code);
    await client.query(`UPDATE console_user_profiles SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE user_password_id = $1`, [id]);
    await audit(client, u.username, 'user.2fa_disable', 'ปิด 2FA');
  });
}

/** Login second factor. Throws totp_required when a code is needed but missing. */
export async function checkLoginCode(client, id, code) {
  const { rows } = await client.query('SELECT totp_secret, totp_last_step FROM console_user_profiles WHERE user_password_id = $1 FOR UPDATE', [id]);
  const u = rows[0];
  if (!u?.totp_secret) return;
  if (!code) throw Object.assign(new UnauthorizedError('2FA code required'), { code: 'totp_required' });
  const step = totp.verify(open(u.totp_secret), code);
  if (step == null || (u.totp_last_step != null && step <= Number(u.totp_last_step))) throw Object.assign(new UnauthorizedError('Invalid 2FA code'), { code: 'totp_invalid' });
  await client.query('UPDATE console_user_profiles SET totp_last_step = $2 WHERE user_password_id = $1', [id, step]);
}
