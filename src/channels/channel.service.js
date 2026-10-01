import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { seal } from '../shared/secret-box.js';

const TYPES = ['telegram', 'line', 'facebook', 'email', 'sms'];
const PROVIDER = { telegram: 'Telegram', line: 'LINE', facebook: 'Facebook', email: 'IMAP', sms: 'Forwarder' };

// Which config keys are secrets (sealed at rest, write-only from the console).
export const SECRET_FIELDS = new Set([
  'botToken', 'webhookSecret', 'accessToken', 'channelSecret', 'pageToken', 'appSecret', 'imapPassword',
  'thunderAccessToken', 'slipOkApiKey', 'easySlipApiKey', 'slip2goSecretKey',
]);

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const createBodySchema = z.object({ type: z.enum(TYPES), name: z.string().trim().min(1).max(120) });
const scalar = z.union([z.string().max(2000), z.boolean(), z.number()]);
export const updateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  config: z.record(z.string().regex(/^[a-zA-Z0-9]{1,40}$/), scalar),
  secrets: z.record(z.string().regex(/^[a-zA-Z0-9]{1,40}$/), z.string().max(2000)).default({}),
  accountIds: z.array(z.coerce.number().int().positive()).max(100),
  endpointIds: z.array(z.coerce.number().int().positive()).max(100),
});

const audit = (client, actor, action, ref, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, $2, 'channel', $3, $4)`, [actor ?? 'console', action, ref, detail]);

export function create(actor, { type, name }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO channels (name, channel_type, provider, account, status, enabled) VALUES ($1, $2, $3, '—', 'active', true) RETURNING id`,
      [name, type, PROVIDER[type]],
    );
    await audit(client, actor, 'channel.create', String(rows[0].id), `เพิ่มช่องทาง ${type}: ${name}`);
    return { id: rows[0].id };
  });
}

/** Saves the card. Secret fields: a non-empty value replaces the sealed one; empty = keep. */
export function update(id, actor, body) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, secrets_enc FROM channels WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError(`Channel ${id} does not exist`);
    const leaked = Object.keys(body.config).filter((k) => SECRET_FIELDS.has(k));
    if (leaked.length) throw new BadRequestError(`Secret fields must be sent in "secrets", not "config": ${leaked.join(', ')}`);
    const sealed = { ...rows[0].secrets_enc };
    const changed = [];
    for (const [k, v] of Object.entries(body.secrets)) {
      if (!SECRET_FIELDS.has(k)) throw new BadRequestError(`${k} is not a secret field`);
      if (v.trim()) {
        sealed[k] = seal(v.trim());
        changed.push(k);
      }
    }
    if (body.accountIds.length) {
      const { rows: ok } = await client.query('SELECT count(*)::int n FROM bank_accounts WHERE id = ANY($1::int[])', [body.accountIds]);
      if (ok[0].n !== new Set(body.accountIds).size) throw new BadRequestError('Unknown bank account in accountIds');
    }
    await client.query(
      `UPDATE channels SET name = $2, enabled = $3, status = CASE WHEN $3 THEN 'active' ELSE 'inactive' END, config = $4, secrets_enc = $5,
              account_ids = $6, endpoint_ids = $7, updated_at = now() WHERE id = $1`,
      [id, body.name, body.enabled, body.config, sealed, [...new Set(body.accountIds)], [...new Set(body.endpointIds)]],
    );
    await audit(client, actor, 'channel.update', String(id), changed.length ? `อัปเดต + เปลี่ยน ${changed.join(', ')}` : 'อัปเดตการตั้งค่า');
  });
}

export function remove(id, actor) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT name FROM channels WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new NotFoundError(`Channel ${id} does not exist`);
    const { rows: used } = await client.query('SELECT count(*)::int n FROM inbound_events WHERE channel_id = $1', [id]);
    if (used[0].n > 0) {
      // Keep history: a channel with events is switched off rather than deleted.
      await client.query(`UPDATE channels SET enabled = false, status = 'inactive', updated_at = now() WHERE id = $1`, [id]);
      await audit(client, actor, 'channel.disable', String(id), `ปิด ${rows[0].name} (มี event ${used[0].n} รายการ)`);
      return { disabled: true };
    }
    await client.query('DELETE FROM channels WHERE id = $1', [id]);
    await audit(client, actor, 'channel.delete', String(id), `ลบ ${rows[0].name}`);
    return { deleted: true };
  });
}
