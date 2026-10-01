import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { NotFoundError } from '../errors.js';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const renameBodySchema = z.object({ name: z.string().trim().min(1).max(80) });

const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'device', $3, $4)`, [actor ?? 'console', action, ref, detail]);

async function lock(client, id) {
  const { rows } = await client.query('SELECT * FROM forwarder_devices WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new NotFoundError(`Device ${id} does not exist`);
  return rows[0];
}

export const rename = (id, actor, { name }) =>
  withTransaction(async (c) => {
    const d = await lock(c, id);
    await c.query('UPDATE forwarder_devices SET name = $2 WHERE id = $1', [id, name]);
    await audit(c, actor, 'device.rename', d.device_uid, `${d.name} → ${name}`);
  });

/** Suspend: the device can no longer post messages, without rotating the channel secret. */
export const suspend = (id, actor) =>
  withTransaction(async (c) => {
    const d = await lock(c, id);
    await c.query(`UPDATE forwarder_devices SET status = 'disabled' WHERE id = $1`, [id]);
    await audit(c, actor, 'device.suspend', d.device_uid, `ระงับ ${d.name}`);
  });

export const resume = (id, actor) =>
  withTransaction(async (c) => {
    const d = await lock(c, id);
    await c.query(`UPDATE forwarder_devices SET status = 'offline' WHERE id = $1`, [id]);
    await audit(c, actor, 'device.resume', d.device_uid, `เปิดใช้ ${d.name}`);
  });

export const remove = (id, actor) =>
  withTransaction(async (c) => {
    const d = await lock(c, id);
    await c.query('DELETE FROM forwarder_devices WHERE id = $1', [id]);
    await audit(c, actor, 'device.delete', d.device_uid, `ลบ ${d.name}`);
  });
