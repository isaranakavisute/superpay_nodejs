import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { open, seal } from '../shared/secret-box.js';
import { safePost } from '../shared/safe-fetch.js';

export const ALERT_KINDS = [
  'withdrawal.pending', 'outflow.pending', 'double_credit.detected', 'low_balance',
  'device.offline', 'channel.error', 'webhook.failed', 'slip.provider_down',
];

const bot = z.object({
  id: z.coerce.number().int().positive().optional(),    // absent = new bot
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  botChannelId: z.coerce.number().int().positive().nullable(),
  botToken: z.string().trim().max(200).optional(),        // blank = keep current
  chatIds: z.string().trim().max(500),
  events: z.array(z.enum(ALERT_KINDS)).max(ALERT_KINDS.length),
});
export const saveBodySchema = z.object({
  bots: z.array(bot).max(20),
  deleted: z.array(z.coerce.number().int().positive()).default([]),
  thresholds: z.object({
    repeatMinutes: z.coerce.number().int().min(1).max(1440),
    slipFailCount: z.coerce.number().int().min(1).max(100),
    slipDownMinutes: z.coerce.number().int().min(1).max(1440),
  }),
});
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const mask = (ids) => ids.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x.length > 6 ? `${x.slice(0, 4)}···${x.slice(-4)}` : x)).join(', ');

export async function load() {
  const { rows: bots } = await query(
    `SELECT a.id, a.name, a.enabled, a.bot_channel_id AS "botChannelId", (a.bot_token_enc IS NOT NULL) AS "hasOwnToken",
            a.chat_ids AS "chatIds", a.events, a.last_sent_at AS "lastSentAt", a.updated_at AS "updatedAt"
       FROM alert_channels a ORDER BY a.id`,
  );
  const { rows: s } = await query(`SELECT key, value FROM console_settings WHERE key LIKE 'alerts.%'`);
  const v = Object.fromEntries(s.map((r) => [r.key, Number(r.value)]));
  return {
    bots,
    kinds: ALERT_KINDS,
    thresholds: { repeatMinutes: v['alerts.repeat_minutes'] ?? 15, slipFailCount: v['alerts.slip_fail_count'] ?? 3, slipDownMinutes: v['alerts.slip_down_minutes'] ?? 5 },
  };
}

/** Saves every bot card plus the thresholds in one transaction (the page's single save button). */
export function save(actor, { bots, deleted, thresholds }) {
  return withTransaction(async (client) => {
    if (deleted.length) await client.query('DELETE FROM alert_channels WHERE id = ANY($1::int[])', [deleted]);
    for (const b of bots) {
      if (b.botChannelId) {
        const { rows } = await client.query(`SELECT 1 FROM channels WHERE id = $1 AND channel_type = 'telegram'`, [b.botChannelId]);
        if (!rows[0]) throw new BadRequestError(`Channel ${b.botChannelId} is not a Telegram channel`);
      }
      const token = b.botToken ? seal(b.botToken) : null;
      const status = b.enabled ? 'active' : 'paused';
      if (b.id) {
        const { rowCount } = await client.query(
          `UPDATE alert_channels SET name = $2, enabled = $3, status = $4, bot_channel_id = $5, bot_token_enc = coalesce($6, bot_token_enc),
                  chat_ids = $7, chat_masked = $8, events = $9, updated_at = now() WHERE id = $1`,
          [b.id, b.name, b.enabled, status, b.botChannelId, token, b.chatIds, mask(b.chatIds) || '—', b.events],
        );
        if (!rowCount) throw new NotFoundError(`Alert bot ${b.id} does not exist`);
      } else {
        await client.query(
          `INSERT INTO alert_channels (name, enabled, status, bot_channel_id, bot_token_enc, chat_ids, chat_masked, events) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [b.name, b.enabled, status, b.botChannelId, token, b.chatIds, mask(b.chatIds) || '—', b.events],
        );
      }
    }
    for (const [key, value] of [['alerts.repeat_minutes', thresholds.repeatMinutes], ['alerts.slip_fail_count', thresholds.slipFailCount], ['alerts.slip_down_minutes', thresholds.slipDownMinutes]]) {
      await client.query(
        `INSERT INTO console_settings (key, grp, label, value) VALUES ($1, 'แจ้งเตือน', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, String(value)],
      );
    }
    await client.query(`INSERT INTO audit_logs (actor, action, entity, detail) VALUES ($1, 'alerts.update', 'setting', $2)`, [actor ?? 'console', `${bots.length} bot`]);
  });
}

/** ⚡ ทดสอบ: send a real Telegram message to each chat id; reports per chat. */
export async function test(id, actor) {
  const { rows } = await query(
    `SELECT a.name, a.chat_ids, a.bot_token_enc, c.secrets_enc->>'botToken' AS channel_token
       FROM alert_channels a LEFT JOIN channels c ON c.id = a.bot_channel_id WHERE a.id = $1`,
    [id],
  );
  const a = rows[0];
  if (!a) throw new NotFoundError(`Alert bot ${id} does not exist`);
  const sealed = a.bot_token_enc ?? a.channel_token;
  const chats = a.chat_ids.split(',').map((x) => x.trim()).filter(Boolean);
  if (!sealed || chats.length === 0) throw new BadRequestError('ต้องมี bot token และ chat id อย่างน้อย 1 รายการ');
  const token = open(sealed);
  const results = [];
  for (const chat of chats) {
    try {
      const r = await safePost(`https://api.telegram.org/bot${token}/sendMessage`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: `✅ ทดสอบการแจ้งเตือนจาก Option Pay (${a.name})` }),
      });
      const ok = r.status === 200 && /"ok":true/.test(r.body);
      const detail = ok ? 'ส่งสำเร็จ' : (r.body.match(/"description":"([^"]+)"/)?.[1] ?? `HTTP ${r.status}`);
      results.push({ chat, ok, detail });
    } catch (err) {
      results.push({ chat, ok: false, detail: err?.cause?.code ?? err?.message ?? 'ส่งไม่ได้' });
    }
  }
  if (results.some((r) => r.ok)) await query('UPDATE alert_channels SET last_sent_at = now() WHERE id = $1', [id]);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'alerts.test', 'setting', $2, $3)`, [
    actor ?? 'console', a.name, results.map((r) => `${r.ok ? '✓' : '✗'} ${r.chat}`).join(' '),
  ]);
  return { results };
}
