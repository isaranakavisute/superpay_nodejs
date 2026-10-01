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

export const saveBodySchema = z.object({ roles: z.record(z.string().regex(/^[a-z_]{2,40}$/), z.array(z.string().max(60)).max(ALL.size)) });

export function save(actor, { roles }) {
  return withTransaction(async (client) => {
    const changed = [];
    for (const [code, perms] of Object.entries(roles)) {
      if (code === 'super_admin') throw new BadRequestError('Super Admin always has every permission and cannot be edited');
      const unknown = perms.filter((p) => !ALL.has(p));
      if (unknown.length) throw new BadRequestError(`Unknown permission(s): ${unknown.join(', ')}`);
      const { rowCount } = await client.query('UPDATE console_roles SET permissions = $2 WHERE code = $1', [code, [...new Set(perms)].sort()]);
      if (!rowCount) throw new BadRequestError(`Unknown role ${code}`);
      changed.push(code);
    }
    await client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'role.update', 'role', $2, $3)`, [
      actor ?? 'console', changed.join(','), `แก้สิทธิ์ ${changed.length} บทบาท`,
    ]);
    return { changed };
  });
}
