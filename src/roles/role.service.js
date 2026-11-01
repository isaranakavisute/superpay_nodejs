import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { BadRequestError } from '../errors.js';

// Permission catalogue, grouped as on the roles page. super_admin always holds '*'.
export const PERMISSIONS = [
  ['เงินเข้า', ['payment.view', 'payment.create', 'payment.approve', 'payment.refund', 'payment.double_credit']],
  ['เงินออก & ถอน', ['outflow.view', 'outflow.approve', 'withdrawal.view', 'withdrawal.approve', 'p2p.manage']],
  ['ร้านค้า', ['merchant.view', 'merchant.manage', 'merchant.credit', 'webhook.view', 'webhook.retry']],
  ['บัญชี & ช่องทาง', ['account.view', 'account.edit', 'channel.view', 'channel.edit', 'event.match', 'device.manage']],
  ['ระบบ', ['user.view', 'user.manage', 'role.manage', 'audit.view', 'settings.manage', 'alerts.manage']],
];
const ALL = new Set(PERMISSIONS.flatMap(([, p]) => p));

const ROLE = z.string().regex(/^[a-z_]{2,40}$/);
// hiddenMenus: menu keys (console nav.ts) a role does not see — its permissions still decide what it may do.
export const saveBodySchema = z.object({
  roles: z.record(ROLE, z.array(z.string().max(60)).max(ALL.size)),
  hiddenMenus: z.record(ROLE, z.array(z.string().regex(/^[a-z0-9-]{2,40}$/)).max(60)).optional(),
});

export function save(actor, { roles, hiddenMenus = {} }) {
  return withTransaction(async (client) => {
    const changed = [];
    const menus = [];
    for (const [code, keys] of Object.entries(hiddenMenus)) {
      if (code === 'super_admin') throw new BadRequestError('Super Admin always sees every menu and cannot be edited');
      const { rowCount } = await client.query('UPDATE console_roles SET hidden_menus = $2 WHERE code = $1', [code, [...new Set(keys)].sort()]);
      if (!rowCount) throw new BadRequestError(`Unknown role ${code}`);
      menus.push(code);
    }
    for (const [code, perms] of Object.entries(roles)) {
      if (code === 'super_admin') throw new BadRequestError('Super Admin always has every permission and cannot be edited');
      const unknown = perms.filter((p) => !ALL.has(p));
      if (unknown.length) throw new BadRequestError(`Unknown permission(s): ${unknown.join(', ')}`);
      const { rowCount } = await client.query('UPDATE console_roles SET permissions = $2 WHERE code = $1', [code, [...new Set(perms)].sort()]);
      if (!rowCount) throw new BadRequestError(`Unknown role ${code}`);
      changed.push(code);
    }
    const detail = [changed.length ? `แก้สิทธิ์ ${changed.length} บทบาท` : '', menus.length ? `แก้เมนูที่แสดง ${menus.length} บทบาท` : ''].filter(Boolean).join(' · ');
    await client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'role.update', 'role', $2, $3)`, [
      actor ?? 'console', [...new Set([...changed, ...menus])].join(','), detail || 'ไม่มีการเปลี่ยนแปลง',
    ]);
    return { changed, menus };
  });
}
