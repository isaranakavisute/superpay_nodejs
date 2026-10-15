import { createHmac, randomBytes } from 'node:crypto';
import { DEFAULT_MERCHANT_PERMS, PERMISSION_CODES } from '../merchant-api/permission-catalog.js';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import logger from '../logger.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { open, seal } from '../shared/secret-box.js';
import { BlockedUrlError, safeGet, safePost } from '../shared/safe-fetch.js';
import { sendAlert } from '../alerts/alert.service.js';

/**
 * The settings page: one typed jsonb document per section in console_config.
 * Secrets (provider keys, webhook signing secrets) are sealed at rest and only
 * ever leave as a mask; saving the mask back keeps the stored value.
 */
const money = z.coerce.number().min(0).max(10_000_000);
const int = (min, max) => z.coerce.number().int().min(min).max(max);
const PROVIDERS = ['none', 'thunder', 'slipok', 'easyslip', 'slip2go'];
export const THEMES = ['royal-gold', 'midnight'];
const SECRET_FIELDS = { slip: ['thunderAccessToken', 'slipOkApiKey', 'easySlipApiKey', 'slip2goSecretKey'], slipBot: ['botToken', 'webhookSecret'], supportBot: ['botToken', 'webhookSecret'] };

export const SECTIONS = {
  brand: {
    schema: z.object({
      siteName: z.string().trim().min(1).max(40),
      tagline: z.string().trim().max(60),
      loginHeadline: z.string().trim().max(120),
      loginSubtext: z.string().trim().max(240),
      logoScale: int(50, 200),
    }),
    defaults: { siteName: 'Option Pay', tagline: 'Payment Console', loginHeadline: '', loginSubtext: '', logoScale: 100, logoAsset: null, faviconAsset: null },
  },
  theme: {
    schema: z.object({ default: z.enum(THEMES), allowUser: z.boolean(), enabled: z.array(z.enum(THEMES)).max(THEMES.length) }),
    defaults: { default: 'royal-gold', allowUser: true, enabled: ['royal-gold', 'midnight'] },
  },
  sounds: {
    schema: z.object({ sequence: z.array(z.string().regex(/^(builtin:[a-z0-9]+|custom:[a-f0-9]{12})$/)).max(20) }),
    defaults: { sequence: ['builtin:chime'] },
  },
  slip: {
    schema: z.object({
      provider: z.enum(PROVIDERS),
      thunderAccessToken: z.string().max(300),
      slipOkApiKey: z.string().max(300),
      slipOkBranchId: z.string().trim().max(40),
      easySlipApiKey: z.string().max(300),
      slip2goApiUrl: z.string().trim().max(200).refine((v) => v === '' || /^https:\/\//.test(v), 'ต้องขึ้นต้นด้วย https://'),
      slip2goSecretKey: z.string().max(300),
      fallbackProvider: z.enum(['', ...PROVIDERS.filter((p) => p !== 'none')]),
      failoverAfter: int(1, 100),
      failoverMinutes: int(1, 1440),
      failoverTrustNotFound: z.boolean(),
      autoMatchAmount: z.boolean(),
      autoMatchTimeWindow: int(1, 168),
      requireApproval: z.boolean(),
      slipAgeCheck: z.boolean(),
      slipMaxAgeHours: int(0, 720),
      uniqueAmount: z.boolean(),
      uniqueAmountMaxSatang: int(0, 99),
      uniqueAmountCooldownMinutes: int(0, 1440).default(60),   // shared accounts: an amount isn't reused for this long
      orderTtlMinutes: int(0, 10080),
      intentPurgeDays: int(0, 365),
      smsStrictAllChannels: z.boolean(),
      centralReceiving: z.boolean(),
      centralDistribution: z.enum(['auto', 'count', 'random', 'fixed']),
      centralFixedAccountId: z.union([z.literal(''), z.coerce.number().int().positive()]),
      p2pMatching: z.boolean(),
      p2pRepoolGraceMinutes: int(0, 1440),
      p2pStaleAfterMinutes: int(0, 10080),
      p2pAutoPayout: z.boolean(),
    }),
    defaults: {
      provider: 'none', thunderAccessToken: '', slipOkApiKey: '', slipOkBranchId: '', easySlipApiKey: '', slip2goApiUrl: '', slip2goSecretKey: '',
      fallbackProvider: '', failoverAfter: 3, failoverMinutes: 5, failoverTrustNotFound: false, autoMatchAmount: true, autoMatchTimeWindow: 24,
      requireApproval: false, slipAgeCheck: true, slipMaxAgeHours: 6, uniqueAmount: false, uniqueAmountMaxSatang: 99, uniqueAmountCooldownMinutes: 60, orderTtlMinutes: 15,
      intentPurgeDays: 7, smsStrictAllChannels: false, centralReceiving: true, centralDistribution: 'auto', centralFixedAccountId: '',
      p2pMatching: false, p2pRepoolGraceMinutes: 5, p2pStaleAfterMinutes: 30, p2pAutoPayout: false,
    },
  },
  quota: { schema: z.object({ threshold: int(0, 1_000_000) }), defaults: { threshold: 500, status: null } },
  // Telegram slip-check bot: send a slip, get "valid slip" / the reason it isn't (telegram/slip-bot.service.js).
  slipBot: {
    schema: z.object({
      enabled: z.boolean(),
      botToken: z.string().max(200),
      webhookSecret: z.string().max(200),
      allowedChatIds: z.string().max(1000),   // comma-separated Telegram chat ids allowed to use the bot
      allGroups: z.boolean().default(true),     // every group the bot is added to may use it (no approval)
      allowPrivate: z.boolean().default(true),  // anyone may use it in a private chat (no approval)
    }),
    defaults: { enabled: false, botToken: '', webhookSecret: '', allowedChatIds: '', allGroups: true, allowPrivate: true },
  },
  // Telegram support bot: answers scripted questions in the group (telegram/support-bot.service.js).
  supportBot: {
    schema: z.object({
      enabled: z.boolean(),
      botToken: z.string().max(200),
      webhookSecret: z.string().max(200),
      allowedChatIds: z.string().max(1000),
      minScore: z.coerce.number().min(0.3).max(1),   // how close a message must be to a question (0.3 loose – 1 exact)
      allowPrivate: z.boolean().default(true),       // anyone may ask the bot in a private chat
      allGroups: z.boolean().default(true),          // answer in every group the bot is a member of (else only allowedChatIds)
    }),
    defaults: { enabled: false, botToken: '', webhookSecret: '', allowedChatIds: '', minScore: 0.55, allowPrivate: true, allGroups: true },
  },
  balance: { schema: z.object({ minMerchantBalance: money }), defaults: { minMerchantBalance: 0 } },
  limits: { schema: z.object({ minDeposit: money, minWithdraw: money }), defaults: { minDeposit: 0, minWithdraw: 0 } },
  security: {
    schema: z.object({ enforce2fa: z.boolean(), ownerUserId: z.union([z.null(), z.coerce.number().int().positive()]) }),
    defaults: { enforce2fa: false, ownerUserId: null },
  },
  merchantPerms: {
    schema: z.object({ owner: z.array(z.enum(PERMISSION_CODES)).max(PERMISSION_CODES.length), staff: z.array(z.enum(PERMISSION_CODES)).max(PERMISSION_CODES.length), viewer: z.array(z.enum(PERMISSION_CODES)).max(PERMISSION_CODES.length) }),
    defaults: DEFAULT_MERCHANT_PERMS,
  },
  outbound: {
    schema: z.object({
      destinations: z.array(z.object({
        id: z.string().regex(/^[a-f0-9]{8}$/).optional(),
        name: z.string().trim().min(1).max(60),
        url: z.string().trim().url().max(500).refine((v) => v.startsWith('https://'), 'ต้องเป็น https://'),
        secret: z.string().max(200),
        enabled: z.boolean(),
      })).max(20),
    }),
    defaults: { destinations: [] },
  },
};
export const sectionParamSchema = z.object({ section: z.enum(Object.keys(SECTIONS)) });

const mask = (v) => (v ? `••••••••${v.slice(-4)}` : '');
const isMask = (v) => typeof v === 'string' && v.startsWith('••••••••');
const openSafe = (v) => { try { return v ? open(v) : ''; } catch { return ''; } };

/** Raw stored value merged over defaults; secrets still sealed. */
async function raw(section, client = { query }) {
  const { rows } = await client.query('SELECT value, updated_at, updated_by FROM console_config WHERE section = $1', [section]);
  return { value: { ...SECTIONS[section].defaults, ...(rows[0]?.value ?? {}) }, updatedAt: rows[0]?.updated_at ?? null, updatedBy: rows[0]?.updated_by ?? null };
}

/** Decrypted value for internal use (provider calls, outbound signing). */
export async function internal(section) {
  const { value } = await raw(section);
  for (const f of SECRET_FIELDS[section] ?? []) value[f] = openSafe(value[f]);
  if (section === 'outbound') value.destinations = value.destinations.map((d) => ({ ...d, secret: openSafe(d.secret) }));
  return value;
}

/** Public (masked) view of one section. */
function present(section, value) {
  const v = { ...value };
  for (const f of SECRET_FIELDS[section] ?? []) v[f] = mask(openSafe(v[f]));
  if (section === 'outbound') v.destinations = v.destinations.map((d) => ({ ...d, secret: mask(openSafe(d.secret)) }));
  return v;
}

export async function getAll() {
  const out = {};
  for (const section of Object.keys(SECTIONS)) {
    const r = await raw(section);
    out[section] = { ...present(section, r.value), updatedAt: r.updatedAt, updatedBy: r.updatedBy };
  }
  const { rows } = await query(`SELECT id, name, mime, octet_length(data) AS bytes, created_at AS "createdAt" FROM console_assets WHERE kind = 'sound' ORDER BY created_at`);
  out.customSounds = rows;
  return out;
}

/** Non-secret sections read on every page (sidebar, login, favicon, theme, 2FA rule, payout sound). */
export async function getPublic() {
  const [b, t, sec, snd, mp] = await Promise.all([raw('brand'), raw('theme'), raw('security'), raw('sounds'), raw('merchantPerms')]);
  return { brand: b.value, theme: t.value, security: sec.value, sounds: snd.value, merchantPerms: mp.value };
}

const audit = (client, actor, section, detail) =>
  client.query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'settings.update', 'settings', $2, $3)`, [actor ?? 'console', section, detail]);

export function save(section, actor, body) {
  const parsed = SECTIONS[section].schema.parse(body);
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`console_config:${section}`]);
    const { value: prev } = await raw(section, client);
    const next = { ...prev, ...parsed };
    for (const f of SECRET_FIELDS[section] ?? []) next[f] = isMask(parsed[f]) ? prev[f] : parsed[f] ? seal(parsed[f]) : '';
    if (section === 'theme') {
      if (!next.enabled.includes(next.default)) next.enabled = [next.default, ...next.enabled];
    }
    if (section === 'security' && next.ownerUserId != null) {
      const { rows } = await client.query('SELECT 1 FROM console_user_profiles WHERE user_password_id = $1', [next.ownerUserId]);
      if (!rows[0]) throw new BadRequestError('ไม่พบบัญชีเจ้าของระบบที่เลือก');
    }
    if (section === 'outbound') {
      const old = Object.fromEntries(prev.destinations.map((d) => [d.id, d]));
      next.destinations = parsed.destinations.map((d) => {
        const id = d.id && old[d.id] ? d.id : randomBytes(4).toString('hex');
        const secret = isMask(d.secret) ? old[id]?.secret ?? '' : d.secret ? seal(d.secret) : seal(randomBytes(24).toString('base64url'));
        return { id, name: d.name, url: d.url, enabled: d.enabled, secret };
      });
    }
    await client.query(
      `INSERT INTO console_config (section, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [section, JSON.stringify(next), actor],
    );
    await audit(client, actor, section, `บันทึกการตั้งค่า: ${section}`);
    return { value: present(section, next) };
  });
}

// ---------- assets (logo, favicon, custom sounds) ----------

const LIMITS = { logo: 8 << 20, favicon: 8 << 20, sound: 2 << 20 };
const MIMES = { logo: ['image/png', 'image/jpeg', 'image/webp'], favicon: ['image/png', 'image/jpeg', 'image/webp'], sound: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg'] };
const MAGIC = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['audio/wav', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE'],
  ['audio/x-wav', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE'],
  ['audio/ogg', (b) => b.toString('latin1', 0, 4) === 'OggS'],
  ['audio/mpeg', (b) => b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
];

export const kindParamSchema = z.object({ kind: z.enum(['logo', 'favicon', 'sound']) });
export const assetBodySchema = z.object({ mime: z.string().max(40), data: z.string().max(12_000_000), name: z.string().trim().max(40).optional() });

export function uploadAsset(kind, actor, { mime, data, name }) {
  if (!MIMES[kind].includes(mime)) throw new BadRequestError(`ไฟล์ต้องเป็น ${MIMES[kind].join(' / ')}`);
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0 || buf.length > LIMITS[kind]) throw new BadRequestError(`ไฟล์ต้องไม่เกิน ${LIMITS[kind] >> 20} MB`);
  if (!MAGIC.find(([m]) => m === mime)?.[1](buf)) throw new BadRequestError('เนื้อไฟล์ไม่ตรงกับชนิดไฟล์');
  const id = randomBytes(6).toString('hex');
  return withTransaction(async (client) => {
    await client.query('INSERT INTO console_assets (id, kind, name, mime, data, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [id, kind, name || kind, mime, buf, actor]);
    if (kind === 'sound') {
      const { value } = await raw('sounds', client);
      await client.query(
        `INSERT INTO console_config (section, value, updated_by) VALUES ('sounds', $1, $2)
         ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify({ ...value, sequence: [...value.sequence, `custom:${id}`] }), actor],
      );
    } else {
      // Logo / favicon: point brand at the new file and drop the old one.
      const field = `${kind}Asset`;
      const { value } = await raw('brand', client);
      if (value[field]) await client.query('DELETE FROM console_assets WHERE id = $1', [value[field]]);
      await client.query(
        `INSERT INTO console_config (section, value, updated_by) VALUES ('brand', $1, $2)
         ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify({ ...value, [field]: id }), actor],
      );
    }
    await audit(client, actor, kind, `อัปโหลด ${kind}: ${name || kind}`);
    return { id };
  });
}

export function removeAsset(kind, actor, id) {
  return withTransaction(async (client) => {
    if (kind === 'sound') {
      const { rowCount } = await client.query(`DELETE FROM console_assets WHERE id = $1 AND kind = 'sound'`, [id]);
      if (!rowCount) throw new NotFoundError('ไม่พบไฟล์เสียง');
      const { value } = await raw('sounds', client);
      await client.query(`UPDATE console_config SET value = $1, updated_by = $2, updated_at = now() WHERE section = 'sounds'`, [JSON.stringify({ ...value, sequence: value.sequence.filter((s) => s !== `custom:${id}`) }), actor]);
    } else {
      const field = `${kind}Asset`;
      const { value } = await raw('brand', client);
      if (value[field]) await client.query('DELETE FROM console_assets WHERE id = $1', [value[field]]);
      await client.query(
        `INSERT INTO console_config (section, value, updated_by) VALUES ('brand', $1, $2)
         ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify({ ...value, [field]: null }), actor],
      );
    }
    await audit(client, actor, kind, `ลบ ${kind}`);
  });
}

export async function getAsset(id) {
  const { rows } = await query('SELECT mime, data FROM console_assets WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('ไม่พบไฟล์');
  return rows[0];
}

// ---------- slip provider test / quota ----------

/**
 * Real calls to the provider's account/quota endpoint (does not use quota).
 * Only providers with a documented account endpoint are supported.
 */
async function probe(provider, cfg) {
  try {
    if (provider === 'easyslip') {
      if (!cfg.easySlipApiKey) return { ok: false, message: 'ยังไม่ได้ใส่ EasySlip API Key' };
      const r = await safeGet('https://developer.easyslip.com/api/v1/me', { headers: { authorization: `Bearer ${cfg.easySlipApiKey}` } });
      const j = JSON.parse(r.body || '{}');
      if (r.status !== 200) return { ok: false, message: `EasySlip ตอบ HTTP ${r.status}: ${j.message ?? r.body.slice(0, 120)}`, ms: r.ms };
      const d = j.data ?? {};
      return { ok: true, message: 'เชื่อมต่อ EasySlip สำเร็จ', ms: r.ms, quota: { remaining: d.remainingQuota ?? null, total: d.maxQuota ?? null, used: d.usedQuota ?? null, credit: d.currentCredit ?? null, plan: d.packageName ?? null, expiresAt: d.expiredAt ?? null } };
    }
    if (provider === 'slipok') {
      if (!cfg.slipOkApiKey || !cfg.slipOkBranchId) return { ok: false, message: 'ยังไม่ได้ใส่ SlipOK API Key / Branch ID' };
      const r = await safeGet(`https://api.slipok.com/api/line/apikey/${encodeURIComponent(cfg.slipOkBranchId)}/quota`, { headers: { 'x-authorization': cfg.slipOkApiKey } });
      const j = JSON.parse(r.body || '{}');
      if (r.status !== 200) return { ok: false, message: `SlipOK ตอบ HTTP ${r.status}: ${j.message ?? r.body.slice(0, 120)}`, ms: r.ms };
      return { ok: true, message: 'เชื่อมต่อ SlipOK สำเร็จ', ms: r.ms, quota: { remaining: j.data?.quota ?? null, total: null, used: null, credit: j.data?.credit ?? null, plan: null, expiresAt: null } };
    }
    if (provider === 'none') return { ok: false, message: 'ไม่ได้เลือกผู้ให้บริการ' };
    return { ok: false, message: `ยังไม่รองรับการทดสอบ ${provider} จากระบบนี้ — ตรวจ key ได้ที่ dashboard ของผู้ให้บริการ` };
  } catch (err) {
    if (err instanceof BlockedUrlError) return { ok: false, message: err.message };
    return { ok: false, message: `เชื่อมต่อไม่ได้: ${err.name === 'TimeoutError' ? 'หมดเวลา' : err.message}` };
  }
}

export const testBodySchema = z.object({ which: z.enum(['primary', 'fallback']), form: z.record(z.string(), z.unknown()).optional() });

/** Test with the values currently in the form (masks fall back to the stored secret). */
export async function testProvider(actor, { which, form }) {
  const stored = await internal('slip');
  const cfg = { ...stored };
  for (const [k, v] of Object.entries(form ?? {})) if (typeof v === 'string' && !isMask(v) && k in stored) cfg[k] = v;
  const provider = which === 'primary' ? cfg.provider : cfg.fallbackProvider;
  if (!provider) return { result: { ok: false, message: 'ยังไม่ได้เลือกตัวสำรอง' } };
  const result = await probe(provider, cfg);
  await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ($1, 'settings.slip_test', 'settings', 'slip', $2)`, [actor ?? 'console', `${provider}: ${result.message}`]);
  return { result: { provider, ...result } };
}

export async function checkQuota(actor) {
  const cfg = await internal('slip');
  const out = { checkedAt: new Date().toISOString(), primary: null, fallback: null };
  if (cfg.provider && cfg.provider !== 'none') out.primary = { provider: cfg.provider, ...(await probe(cfg.provider, cfg)) };
  if (cfg.fallbackProvider) out.fallback = { provider: cfg.fallbackProvider, ...(await probe(cfg.fallbackProvider, cfg)) };
  await withTransaction(async (client) => {
    const { value } = await raw('quota', client);
    await client.query(
      `INSERT INTO console_config (section, value, updated_by) VALUES ('quota', $1, $2)
       ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ ...value, status: out }), actor],
    );
  });
  return { status: out };
}

// ---------- outbound webhooks (fired on payment approve) ----------

/** Fire-and-forget after commit: POST a signed payment.approved to every enabled destination. */
export function notifyPaymentApproved(payment) {
  (async () => {
    const { destinations } = await internal('outbound');
    const live = destinations.filter((d) => d.enabled);
    if (!live.length) return;
    const body = JSON.stringify({ event: 'payment.approved', data: payment, sentAt: new Date().toISOString() });
    await Promise.all(live.map(async (d) => {
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', d.secret).update(`${t}.${body}`).digest('hex');
      let detail;
      let reply = null;
      let ok = false;
      try {
        const r = await safePost(d.url, { body, headers: { 'content-type': 'application/json', 'x-signature': `t=${t},v1=${sig}`, 'user-agent': 'OptionPay-Outbound/1' } });
        detail = `${d.name}: HTTP ${r.status} (${r.ms} ms)`;
        reply = r.body;
        ok = r.status >= 200 && r.status < 300;
      } catch (err) {
        detail = `${d.name}: ล้มเหลว — ${err.message}`;
      }
      await query(`INSERT INTO audit_logs (actor, action, entity, entity_ref, detail) VALUES ('system', 'outbound.deliver', 'payment', $1, $2)`, [payment.ref, detail]);
      // System-wide destination (ตั้งค่าระบบ → outbound): reported to unscoped alert bots.
      await sendAlert('webhook.delivery', [
        `📤 Outbound payment.approved — ${payment.ref}`,
        ok ? `✅ ส่งถึงปลายทางแล้ว — ${detail}` : `❌ ส่งไม่สำเร็จ — ${detail}`,
        `ปลายทาง: ${d.url}`,
        `ข้อมูลที่ส่ง: ${body}`,
        reply !== null ? `ปลายทางตอบ: ${String(reply).slice(0, 500) || '(ว่าง)'}` : null,
      ].filter(Boolean).join('\n'));
    }));
  })().catch((err) => logger.warn({ err }, 'outbound webhook dispatch failed'));
}

/** Effective minimum for a shop: its own min_balance wins when set (> 0). */
export async function minBalanceFor(shopMin) {
  if (Number(shopMin) > 0) return Number(shopMin);
  return Number((await raw('balance')).value.minMerchantBalance) || 0;
}
