import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';

/**
 * Console accounts = user_password (login, owned by another project) +
 * console_user_profiles (this service: name, role, status). Only create and
 * password reset touch user_password; everything else is the profile.
 */
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const base = {
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  roleCode: z.string().regex(/^[a-z_]{2,40}$/),
  status: z.enum(['active', 'inactive']),
};
export const createBodySchema = z.object({
  ...base,
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'username: a–z, 0–9, . _ -'),
  password: z.string().min(6).max(100),
});
export const updateBodySchema = z.object({ ...base, password: z.string().min(6).max(100).optional().or(z.literal('')) });

const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'user', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lock(client, id) {
  const { rows } = await client.query(
    `SELECT p.*, u.myuser AS username FROM console_user_profiles p JOIN user_password u ON u.id = p.user_password_id WHERE p.user_password_id = $1 FOR UPDATE OF p`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`User ${id} does not exist`);
  return rows[0];
}
const notSelf = (u, actor, verb) => {
  if (u.username === actor) throw new ConflictError(`You cannot ${verb} your own account`);
};
async function requireRole(client, code) {
  const { rows } = await client.query('SELECT 1 FROM console_roles WHERE code = $1', [code]);
  if (!rows[0]) throw new BadRequestError(`Unknown role ${code}`);
}

export function create(actor, b) {
  return withTransaction(async (client) => {
    await requireRole(client, b.roleCode);
    const { rows: taken } = await client.query('SELECT 1 FROM user_password WHERE lower(trim(myuser)) = $1', [b.username]);
    if (taken[0]) throw new ConflictError(`Username ${b.username} is already taken`);
    // user_password stores plaintext by its own (pre-existing) design.
    const { rows } = await client.query('INSERT INTO user_password (myuser, mypassword) VALUES ($1, $2) RETURNING id', [b.username, b.password]);
    await client.query(
      `INSERT INTO console_user_profiles (user_password_id, full_name, email, phone, role_code, status) VALUES ($1, $2, nullif($3, ''), nullif($4, ''), $5, $6)`,
      [rows[0].id, b.fullName, b.email ?? '', b.phone ?? '', b.roleCode, b.status],
    );
    await audit(client, actor, 'user.create', b.username, `เพิ่มผู้ใช้ (${b.roleCode})`);
    return { id: rows[0].id };
  });
}

export function update(id, actor, b) {
  return withTransaction(async (client) => {
    const u = await lock(client, id);
    await requireRole(client, b.roleCode);
    if (u.username === actor && b.roleCode !== u.role_code) throw new ConflictError('You cannot change your own role');
    await client.query(
      `UPDATE console_user_profiles SET full_name = $2, email = nullif($3, ''), phone = nullif($4, ''), role_code = $5,
              status = CASE WHEN status IN ('locked', 'deleted') THEN status ELSE $6 END WHERE user_password_id = $1`,
      [id, b.fullName, b.email ?? '', b.phone ?? '', b.roleCode, b.status],
    );
    if (b.password) await client.query('UPDATE user_password SET mypassword = $2 WHERE id = $1', [id, b.password]);
    await audit(client, actor, 'user.update', u.username, b.password ? 'แก้ไขข้อมูล + รีเซ็ตรหัสผ่าน' : 'แก้ไขข้อมูล');
  });
}

const setStatus = (to, verb, action, detail, allowed) => (id, actor) =>
  withTransaction(async (client) => {
    const u = await lock(client, id);
    notSelf(u, actor, verb);
    if (!allowed.includes(u.status)) throw new ConflictError(`${u.username} is ${u.status}`);
    await client.query(`UPDATE console_user_profiles SET status = $2, deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE NULL END WHERE user_password_id = $1`, [id, to]);
    await audit(client, actor, action, u.username, detail);
  });

export const lockUser = setStatus('locked', 'lock', 'user.lock', 'ล็อกบัญชี', ['active', 'inactive']);
export const unlockUser = setStatus('active', 'unlock', 'user.unlock', 'ปลดล็อกบัญชี', ['locked']);
export const deleteUser = setStatus('deleted', 'delete', 'user.delete', 'ลบผู้ใช้ (กู้คืนได้)', ['active', 'inactive', 'locked']);
export const restoreUser = setStatus('active', 'restore', 'user.restore', 'กู้คืนผู้ใช้', ['deleted']);
