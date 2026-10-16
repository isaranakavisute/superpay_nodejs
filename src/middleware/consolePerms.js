import { query } from '../db/pool.js';
import { AppError } from '../errors.js';

/**
 * Role permissions for the admin console (สิทธิ์การเข้าถึง). Runs after
 * requireConsoleKey on /api/console. The Next server names the signed-in
 * operator in x-console-actor (username) and x-console-user-id; their role's
 * permissions decide every write, and the sensitive reads listed below.
 * The merchant portal (/portal) has its own per-shop checks.
 */

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details) {
    super(message, { status: 403, code: 'forbidden', details });
  }
}

// First match wins. Writes not listed here need Super Admin.
const WRITE_RULES = [
  [/^\/payments\/[^/]+\/refund$/, 'payment.refund'],
  [/^\/payments\/?$/, 'payment.create'],
  [/^\/payments\//, 'payment.approve'],
  [/^\/outflows(\/|$)/, 'outflow.approve'],
  [/^\/withdrawals(\/|$)/, 'withdrawal.approve'],
  [/^\/p2p(\/|$)/, 'p2p.manage'],
  [/^\/double-credits(\/|$)/, 'payment.double_credit'],
  [/^\/merchants\/[^/]+\/credits$/, 'merchant.credit'],
  [/^\/merchants\/[^/]+\/rates$/, 'merchant.manage'],
  [/^\/merchants(\/|$)/, 'merchant.manage'],
  [/^\/webhooks\/settings\//, 'merchant.manage'],
  [/^\/webhooks(\/|$)/, 'webhook.retry'],
  [/^\/channels(\/|$)/, 'channel.edit'],
  [/^\/events(\/|$)/, 'event.match'],
  [/^\/devices(\/|$)/, 'device.manage'],
  [/^\/alert-bots(\/|$)/, 'alerts.manage'],
  [/^\/roles-admin(\/|$)/, 'role.manage'],
  [/^\/users-admin(\/|$)/, 'user.manage'],
  [/^\/accounts-admin(\/|$)/, 'account.edit'],
  [/^\/config\/slip\/demo-verify$/, 'channel.view'],
  [/^\/config(\/|$)/, 'settings.manage'],
  [/^\/support-bot(\/|$)/, 'settings.manage'],
];

// Reads that expose secrets or money history; the console sends the operator with these.
const READ_RULES = [
  [/^\/merchants\/[^/]+\/(api-keys|webhook|portal-users)$/, 'merchant.manage'],
  [/^\/merchants\/[^/]+\/credits$/, 'merchant.view'],
  [/^\/merchants\/[^/]+\/breakdown\//, 'merchant.view'],
  [/^\/config\/?$/, 'settings.manage'],
];

const OPEN = /^\/(portal(\/|$)|config\/(public|asset\/))/;
const PROFILE = /^\/profile\/(\d+)(\/|$)/;

const SUPER = '*';

/**
 * The operator's id, role and permissions; null if unknown or not active.
 * Without an id, a username shared by several accounts gets only what all of them have.
 */
export async function resolveOperator(username, userId) {
  if (!username) return null;
  const { rows } = await query(
    `SELECT u.id, p.role_code AS "roleCode", r.permissions
       FROM user_password u
       JOIN console_user_profiles p ON p.user_password_id = u.id
       JOIN console_roles r ON r.code = p.role_code
      WHERE lower(trim(u.myuser)) = lower(trim($1)) AND p.status = 'active'
        AND ($2::int IS NULL OR u.id = $2::int)
      ORDER BY u.id`,
    [username, userId ?? null],
  );
  if (!rows.length) return null;
  const sets = rows.map((r) => new Set(r.roleCode === 'super_admin' ? [SUPER] : r.permissions ?? []));
  const perms = sets.reduce((acc, s) => {
    if (acc.has(SUPER)) return s;
    if (s.has(SUPER)) return acc;
    return new Set([...acc].filter((p) => s.has(p)));
  });
  return { id: rows.length === 1 ? rows[0].id : null, roleCode: rows.length === 1 ? rows[0].roleCode : null, perms };
}

export const hasPerm = (op, perm) => !!op && (op.perms.has(SUPER) || (perm !== SUPER && op.perms.has(perm)));

export const requiredPermission = (method, path) => {
  const rules = method === 'GET' || method === 'HEAD' ? READ_RULES : WRITE_RULES;
  const hit = rules.find(([re]) => re.test(path));
  if (hit) return hit[1];
  return method === 'GET' || method === 'HEAD' ? null : SUPER;
};

export async function consolePerms(req, _res, next) {
  try {
    if (OPEN.test(req.path)) return next();
    const userId = Number(req.get('x-console-user-id')) || null;
    const profile = PROFILE.exec(req.path);
    if (profile) {
      // Self-service: only the signed-in operator's own profile.
      const op = await resolveOperator(req.actor, userId);
      if (!op?.id || op.id !== Number(profile[1])) throw new ForbiddenError('แก้ไขได้เฉพาะโปรไฟล์ของตัวเอง');
      return next();
    }
    const perm = requiredPermission(req.method, req.path);
    if (!perm) return next();
    const op = await resolveOperator(req.actor, userId);
    if (!op) throw new ForbiddenError('ไม่พบผู้ใช้ที่ใช้งานอยู่ — กรุณาเข้าสู่ระบบใหม่');
    if (!hasPerm(op, perm)) {
      throw new ForbiddenError(perm === SUPER ? 'ไม่มีสิทธิ์ทำรายการนี้ (เฉพาะ Super Admin)' : `ไม่มีสิทธิ์ทำรายการนี้ (ต้องมีสิทธิ์ ${perm})`, { permission: perm });
    }
    req.operator = op;
    next();
  } catch (err) {
    next(err);
  }
}

export default consolePerms;
