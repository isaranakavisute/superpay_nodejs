import { z } from 'zod';
import { tgSend } from '../shared/telegram-send.js';
import { query, withTransaction } from '../db/pool.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { open, seal } from '../shared/secret-box.js';

export const ALERT_KINDS = [
  'withdrawal.pending', 'outflow.pending', 'double_credit.detected', 'low_balance',
  'device.offline', 'channel.error', 'webhook.failed', 'slip.provider_down', 'webhook.delivery', 'midnight.cancel',
];

const bot = z.object({
  id: z.coerce.number().int().positive().optional(),    // absent = new bot
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  botChannelId: z.coerce.number().int().positive().nullable(),
  botToken: z.string().trim().max(200).optional(),        // blank = keep current
  chatIds: z.string().trim().max(500),
  mentions: z.string().trim().max(500).default(''),
  merchantId: z.coerce.number().int().positive().nullable().default(null),   // only this shop + the shops under it
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
            a.chat_ids AS "chatIds", a.mentions, a.merchant_id AS "merchantId", a.events, a.last_sent_at AS "lastSentAt", a.updated_at AS "updatedAt"
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
                  chat_ids = $7, chat_masked = $8, events = $9, mentions = $10, merchant_id = $11, updated_at = now() WHERE id = $1`,
          [b.id, b.name, b.enabled, status, b.botChannelId, token, b.chatIds, mask(b.chatIds) || '—', b.events, b.mentions, b.merchantId],
        );
        if (!rowCount) throw new NotFoundError(`Alert bot ${b.id} does not exist`);
      } else {
        await client.query(
          `INSERT INTO alert_channels (name, enabled, status, bot_channel_id, bot_token_enc, chat_ids, chat_masked, events, mentions, merchant_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [b.name, b.enabled, status, b.botChannelId, token, b.chatIds, mask(b.chatIds) || '—', b.events, b.mentions, b.merchantId],
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
      const r = await tgSend(token, 'sendMessage', { chat_id: chat, text: `✅ ทดสอบการแจ้งเตือนจาก Option Pay (${a.name})` });
      const ok = !!r.ok;
      const detail = ok ? 'ส่งสำเร็จ' : r.description ?? 'error';
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

/**
 * Sends `text` to every enabled alert bot subscribed to `kind` (แจ้งเตือน Telegram). A bot scoped to a shop
 * (merchant_id) only gets alerts about that shop or a shop under it; `merchantId` null = system-wide alerts,
 * which go to unscoped bots only. Each chat is tried 3 times; a chat that still fails is written to the audit log.
 * Never throws; returns how many chats received it.
 */
export async function sendAlert(kind, text, { merchantId = null } = {}) {
  let sent = 0;
  try {
    const { rows } = await query(
      `SELECT a.id, a.name, a.chat_ids, a.mentions, a.bot_token_enc, c.secrets_enc->>'botToken' AS channel_token
         FROM alert_channels a LEFT JOIN channels c ON c.id = a.bot_channel_id
        WHERE a.enabled AND $1 = ANY (a.events)
          -- Callback alerts (webhook.delivery) go ONLY to the shop's own group(s) — never to an "all shops" bot — so each
          -- parent shop's callbacks land in its own Telegram group (rule C, 18 Oct 2026; set in ตั้งค่าแจ้งเตือน → เฉพาะร้าน).
          AND ((a.merchant_id IS NULL AND $1 <> 'webhook.delivery') OR a.merchant_id IN (
                WITH RECURSIVE up AS (
                  SELECT id, parent_id, 0 AS depth FROM merchants WHERE id = $2::int
                  UNION ALL SELECT m.id, m.parent_id, up.depth + 1 FROM up JOIN merchants m ON m.id = up.parent_id WHERE up.depth < 10)
                SELECT id FROM up))`,
      [kind, merchantId],
    );
    for (const a of rows) {
      const sealed = a.bot_token_enc ?? a.channel_token;
      if (!sealed) continue;
      const token = open(sealed);
      const tags = mentionHtml(a.mentions);
      const html = `${tags ? `${tags}\n` : ''}${esc(text.slice(0, 3800))}`;
      let ok = false;
      for (const chat of a.chat_ids.split(',').map((x) => x.trim()).filter(Boolean)) {
        // Paced per chat and retried on Telegram 429 (shared rule — shared/telegram-send.js).
        const r = await tgSend(token, 'sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
        if (r.ok) { ok = true; sent += 1; }
        const last = r.ok ? null : r.description ?? 'error';
        if (last) {
          await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('system', 'alerts.failed', 'setting', $1, $2)`,
            [a.name, `ส่งแจ้งเตือน ${kind} ไม่สำเร็จ (chat ${chat}): ${last}`]).catch(() => {});
        }
      }
      if (ok) await query('UPDATE alert_channels SET last_sent_at = now() WHERE id = $1', [a.id]);
    }
  } catch { /* alerts are best effort */ }
  return sent;
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "@username" stays as text (Telegram links it); "Name:<id>" becomes a tag that notifies a user without a username. */
export function mentionHtml(mentions) {
  return String(mentions ?? '').split(',').map((m) => m.trim()).filter(Boolean).map((m) => {
    const byId = /^(.+):(\d{3,15})$/.exec(m);
    if (byId) return `<a href="tg://user?id=${byId[2]}">${esc(byId[1].trim())}</a>`;
    return /^@[A-Za-z0-9_]{4,32}$/.test(m) ? m : esc(m);
  }).join(' ');
}
