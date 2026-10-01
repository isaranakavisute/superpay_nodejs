/**
 * Test data for the console tables from migration 004. Called by
 * seed-dashboard.js inside its transaction, after payments/outflows exist, so
 * every row here points at real refs. Deterministic: its own fixed PRNG seed.
 *
 * user_password is only READ here (ids + usernames) to attach profiles.
 */

// mulberry32 — same generator as the dashboard seed, different seed.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MINUTE = 60_000;
const DAY = 86_400_000;

export const CONSOLE_TABLES = [
  'merchant_portal_users', 'merchant_credit_adjustments', 'merchant_api_keys', 'outflow_slips', 'payment_slips', 'double_credits', 'p2p_matches', 'console_settings', 'console_config', 'console_assets', 'alert_channels', 'webhook_deliveries',
  'webhook_endpoints', 'forwarder_devices', 'inbound_events', 'channels', 'withdrawal_requests',
  'audit_logs', 'console_logins', 'console_user_profiles', 'console_roles',
];

const ROLES = [
  ['super_admin', 'Super Admin', 'ผู้ดูแลสูงสุด — ทำได้ทุกอย่าง', ['*'], 1],
  ['admin', 'Admin', 'ผู้ดูแลระบบ — งานประจำวันทั้งหมด',
    ['account.edit', 'account.view', 'alerts.manage', 'audit.view', 'channel.edit', 'channel.view', 'device.manage', 'event.match', 'merchant.credit', 'merchant.manage', 'merchant.view',
     'outflow.approve', 'outflow.view', 'p2p.manage', 'payment.approve', 'payment.create', 'payment.double_credit', 'payment.refund', 'payment.view', 'user.view',
     'webhook.retry', 'webhook.view', 'withdrawal.approve', 'withdrawal.view'], 2],
  ['finance', 'Manager', 'หัวหน้างาน — ตรวจ + อนุมัติเงินเข้า-ออก',
    ['account.view', 'event.match', 'merchant.view', 'outflow.approve', 'outflow.view', 'payment.approve', 'payment.view', 'withdrawal.approve', 'withdrawal.view'], 3],
  ['support', 'Support', 'ฝ่ายบริการลูกค้า — ดูรายการและช่วยตรวจสลิป', ['channel.view', 'event.match', 'merchant.view', 'payment.create', 'payment.view'], 4],
  ['viewer', 'User', 'พนักงาน — ดูอย่างเดียว', ['merchant.view', 'outflow.view', 'payment.view'], 5],
];

const PEOPLE = ['สมชาย ใจดี', 'วิภา ศรีสุข', 'ณัฐพล แก้วมณี', 'กมลวรรณ พรหมมา', 'ธีรวัฒน์ บุญมา', 'ปิยะนุช ทองดี', 'อนันต์ วงศ์ใหญ่', 'สุดารัตน์ ศรีสุข', 'อิสระ นาคะวิสุทธิ์'];

/** Multi-row INSERT with numbered placeholders. */
async function insertRows(client, table, columns, rows) {
  if (rows.length === 0) return;
  const params = [];
  const tuples = rows.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`);
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
}

export async function seedConsole(client, now) {
  const r = rng(4600);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const ip = () => (r() < 0.6 ? `171.97.${Math.floor(r() * 255)}.${Math.floor(r() * 255)}` : `10.0.${Math.floor(r() * 20)}.${Math.floor(r() * 255)}`);

  // ----- roles & profiles (one per user_password row) -----
  await insertRows(client, 'console_roles', ['code', 'name', 'description', 'permissions', 'sort_order'], ROLES);
  const { rows: accounts } = await client.query('SELECT id, myuser FROM user_password ORDER BY id');
  const roleFor = (u, i) => (u.myuser === 'admin' && i === accounts.findLastIndex((a) => a.myuser === 'admin') ? 'super_admin'
    : u.myuser === 'admin' ? 'admin'
    : u.myuser === 'isara' ? 'super_admin'
    : ['finance', 'support', 'viewer', 'admin', 'finance'][i % 5]);
  const profiles = accounts.map((u, i) => {
    const role = roleFor(u, i);
    const status = u.myuser === 'ubuntu' ? 'inactive' : 'active';
    const fullName = u.myuser === 'admin' && role === 'super_admin' ? PEOPLE[0] : PEOPLE[(i + 1) % PEOPLE.length];
    return { id: u.id, username: u.myuser, fullName, role, status };
  });
  await insertRows(client, 'console_user_profiles', ['user_password_id', 'full_name', 'email', 'phone', 'role_code', 'status', 'created_at'],
    profiles.map((p, i) => [p.id, p.fullName, `${p.username}@superpay.local`, `08${Math.floor(10_000_000 + r() * 89_999_999)}`, p.role, p.status, new Date(now - (90 - i * 7) * DAY)]));
  const staff = profiles.filter((p) => p.status === 'active');
  const approvers = staff.filter((p) => ['super_admin', 'admin', 'finance'].includes(p.role));

  // ----- outflow detail (migration 011): withdrawal payouts point back at their request -----
  await client.query(`UPDATE outflows o SET source = 'withdrawal', description = 'Withdrawal ' || w.ref || ' — ' || coalesce(w.note, 'ถอนตามคำขอร้านค้า')
      FROM withdrawal_requests w WHERE w.outflow_id = o.id`);
  await client.query(`UPDATE outflows SET description = CASE category
      WHEN 'transfer' THEN 'โอนชำระยอดให้ร้านค้าตามรอบ' WHEN 'expense' THEN 'ค่าบริการระบบตรวจสลิป' WHEN 'refund' THEN 'คืนเงินลูกค้าโอนเกิน'
      ELSE 'จ่ายออกตามคำขอ' END WHERE description IS NULL`);
  await client.query(`UPDATE outflows SET completed_at = created_at + ((id % 7) + 2) * interval '1 minute' WHERE status <> 'pending'`);
  // Pending payouts have no deducting account yet — it is chosen at approval.
  await client.query(`UPDATE outflows SET bank_account_id = NULL WHERE status = 'pending'`);

  // ----- payment detail (migration 009) -----
  await client.query(`UPDATE payments SET
      merchant_order_id = CASE WHEN merchant_id IS NULL THEN NULL ELSE 'ORD-' || to_char(created_at AT TIME ZONE 'Asia/Bangkok', 'YYMMDD') || '-' || lpad((id % 10000)::text, 4, '0') END,
      completed_at      = CASE WHEN status IN ('approved', 'rejected', 'refunded') THEN created_at + ((id % 9) + 1) * interval '1 minute' END,
      slip_received_at  = CASE WHEN status = 'pending' AND id % 2 = 0 THEN created_at + interval '2 minutes' END,
      review_note       = CASE WHEN status = 'rejected' THEN (ARRAY['สลิปไม่ชัด', 'ยอดไม่ตรงกับออเดอร์', 'สลิปซ้ำกับรายการอื่น', 'ชื่อผู้โอนไม่ตรง'])[(id % 4) + 1] END,
      refunded_amount   = CASE WHEN status = 'refunded' THEN amount ELSE 0 END`);
  // Some expired orders still carry a slip (they need a person to look), and a
  // few pending/expired slips were already used to credit another order.
  await client.query(`UPDATE payments SET slip_received_at = created_at + interval '3 minutes'
     WHERE status = 'expired' AND id % 5 = 0`);
  await client.query(`UPDATE payments p SET slip_reused_ref = o.ref, slip_received_at = coalesce(p.slip_received_at, p.created_at + interval '1 minute')
      FROM (SELECT id, ref, row_number() OVER (ORDER BY id DESC) AS rn FROM payments WHERE status = 'approved') o
     WHERE p.status IN ('pending', 'expired') AND p.id % 7 = 3 AND o.rn = (p.id % 40) + 1`);
  await client.query(`UPDATE payments SET review_note = 'โอนเข้าบัญชีที่ไม่ใช่ของเรา — ระบบไม่จับคู่'
     WHERE status IN ('pending', 'expired') AND slip_received_at IS NOT NULL AND slip_reused_ref IS NULL AND id % 3 = 0`);

  // ----- account counters: two accounts were reset recently, the rest count from the start -----
  // Every account was reset recently with a hand-set starting balance; payout
  // accounts (KTB send, SCB both) start with a float so payouts don't go negative.
  await client.query(`UPDATE bank_accounts SET
      counters_reset_at = now() - (CASE id WHEN 1 THEN interval '2 days' WHEN 2 THEN interval '3 days'
                                           WHEN 3 THEN interval '20 hours' WHEN 4 THEN interval '3 days' ELSE interval '6 days' END),
      balance_at_reset  = CASE id WHEN 2 THEN 150000 WHEN 4 THEN 250000 WHEN 5 THEN 12500 ELSE 0 END`);
  // PromptPay ids (test numbers) so the checkout can show a QR; BBL stays bank-transfer only.
  await client.query(`UPDATE bank_accounts SET promptpay_id = CASE id WHEN 1 THEN '0812345678' WHEN 2 THEN '0898765432' END`);

  // ----- logins -----
  const logins = [];
  for (const p of staff) {
    const n = 1 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) logins.push([p.id, ip(), new Date(now - Math.floor(r() * 14 * DAY))]);
  }
  await insertRows(client, 'console_logins', ['user_password_id', 'ip', 'logged_in_at'], logins);

  // ----- payments: reviewer; merchants: KYC -----
  await client.query(`UPDATE merchants SET kyc_status = CASE id WHEN 5 THEN 'rejected' WHEN 4 THEN 'pending' ELSE 'verified' END`);
  const { rows: reviewed } = await client.query(`SELECT id FROM payments WHERE status IN ('approved', 'rejected', 'refunded') ORDER BY id`);
  for (const a of approvers) {
    const ids = reviewed.filter((_, i) => i % approvers.length === approvers.indexOf(a)).map((x) => x.id);
    await client.query('UPDATE payments SET reviewed_by = $1 WHERE id = ANY($2::bigint[])', [a.username, ids]);
  }
  // A share of approvals were automatic (slip checker), as in production.
  await client.query(`UPDATE payments SET reviewed_by = 'system' WHERE status = 'approved' AND id % 3 = 0`);

  const { rows: payments } = await client.query(
    `SELECT p.id, p.ref, p.merchant_id, p.customer_name, p.amount, p.status, p.created_at, p.bank_account_id
       FROM payments p ORDER BY p.created_at`);
  const { rows: outflows } = await client.query(
    `SELECT o.id, o.ref, o.merchant_id, o.category, o.receiver_name, o.receiver_bank_code, o.receiver_account, o.amount, o.status, o.created_at
       FROM outflows o ORDER BY o.created_at`);

  // ----- withdrawal requests -----
  // Lifecycle: pending (no payout yet) → approved (payout outflow created; pending
  // until an admin transfers, then approved) or rejected. Every 'other' outflow
  // is the payout of an approved request; a few fresh requests still wait.
  const NOTES = ['ถอนยอดขายประจำสัปดาห์', 'ถอนเข้าบัญชีบริษัท', 'ค่าสินค้าซัพพลายเออร์', null, 'ถอนตามรอบ', null];
  const REJECTS = ['ยอดคงเหลือไม่พอ', 'ชื่อบัญชีปลายทางไม่ตรงกับเจ้าของร้าน', 'ร้านค้าขอยกเลิก'];
  const withdrawals = outflows.filter((o) => o.category === 'other').map((o, i) => {
    const rejected = o.status === 'rejected';
    const created = new Date(new Date(o.created_at).getTime() - (20 + Math.floor(r() * 120)) * MINUTE);
    return [
      `WDR${o.ref.slice(3)}`, o.merchant_id, o.receiver_name, o.receiver_bank_code, o.receiver_account, o.amount,
      NOTES[i % NOTES.length], rejected ? 'rejected' : 'approved', i % 4 === 0 ? 'system' : pick(approvers).username,
      rejected ? null : o.id, created, `idem:${(o.id * 2654435761 % 2 ** 32).toString(16).padStart(8, '0')}`,
      rejected ? REJECTS[i % REJECTS.length] : null, new Date(new Date(o.created_at).getTime() - MINUTE),
    ];
  });
  // Fresh requests waiting for a decision (no payout yet).
  for (let i = 0; i < 5; i++) {
    const m = 1 + Math.floor(r() * 4);
    withdrawals.push([`WDR${90001 + i}`, m, ['ร้านกาแฟดอยช้าง', 'Bangkok Gadget', 'ร้านผ้าไหมสุรินทร์', 'FitLife Gym'][m - 1],
      pick(['KBANK', 'SCB', 'BBL', 'KTB']),
      `${Math.floor(100 + r() * 899)}-${Math.floor(1 + r() * 8)}-${Math.floor(10000 + r() * 89999)}-${Math.floor(r() * 9)}`,
      Math.round((3000 + r() * 25000) * 100) / 100, pick(NOTES), 'pending', null, null, new Date(now - Math.floor(r() * 5 * 3_600_000)),
      `idem:${Math.floor(r() * 2 ** 32).toString(16).padStart(8, '0')}`, null, null]);
  }
  await insertRows(client, 'withdrawal_requests',
    ['ref', 'merchant_id', 'receiver_name', 'receiver_bank_code', 'receiver_account', 'amount', 'note', 'status', 'approved_by', 'outflow_id', 'created_at',
      'merchant_ref', 'reject_reason', 'decided_at'],
    withdrawals);

  // ----- channels & inbound events -----
  const CHANNELS = [
    ['Telegram บอทรับสลิป', 'telegram', 'Telegram', '@superpay_slip_bot'],
    ['Telegram แจ้งยอดเข้า KBANK', 'telegram', 'Telegram', '@superpay_kbank_bot'],
    ['LINE OA รับสลิป', 'line', 'LINE', '@superpay'],
    ['อีเมลแจ้งเงินเข้า KBANK', 'email', 'Gmail', 'kb-alert@···pay.local'],
    ['อีเมลแจ้งเงินเข้า SCB', 'email', 'Gmail', 'scb-alert@···pay.local'],
    ['SMS จากมือถือ Forwarder', 'sms', 'Forwarder', '/hooks/sms/···3d'],
  ];
  await insertRows(client, 'channels', ['name', 'channel_type', 'provider', 'account', 'status'],
    CHANNELS.map((c, i) => [...c, i === 1 ? 'inactive' : 'active']));
  // Non-secret settings and sealed secrets per channel (what the channel cards edit).
  const { seal: sealCh } = await import('../src/shared/secret-box.js');
  const CONFIG = {
    telegram: { allowedChatIds: '-1001234567890', parseRegex: 'จำนวนเงิน\\s*([0-9,.]+)', slipOnly: true, captionKeyword: '', requireOrderId: false, slipProvider: 'default', autoCreatePayment: false, ambiguousLatestOrder: true },
    line: { slipProvider: 'default', autoCreatePayment: false, ambiguousLatestOrder: true },
    email: { imapHost: 'imap.gmail.com', imapPort: '993', imapUser: 'alerts@superpay.local', folder: 'INBOX', senderFilter: 'kplus@kasikornbank.com', slipProvider: 'none', autoCreatePayment: true, ambiguousLatestOrder: false },
    sms: { allowedSenders: 'KBank, SCB', requireRegisteredDevice: true },
  };
  const SECRETS = { telegram: ['botToken', 'webhookSecret'], line: ['accessToken', 'channelSecret'], email: ['imapPassword'], sms: ['webhookSecret'] };
  const { rows: chRows } = await client.query('SELECT id, channel_type FROM channels ORDER BY id');
  for (const c of chRows) {
    const sealed = Object.fromEntries(SECRETS[c.channel_type].map((f) => [f, sealCh(`${f}-${c.id}-${Math.floor(r() * 1e9).toString(36)}`)]));
    await client.query('UPDATE channels SET config = $2, secrets_enc = $3, enabled = (status = $4), account_ids = $5 WHERE id = $1', [
      c.id, CONFIG[c.channel_type], sealed, 'active', [1, 2, 3],
    ]);
  }
  const activeChannels = [1, 3, 4, 5, 6];
  const recent = payments.filter((p) => new Date(p.created_at).getTime() > now - 10 * DAY);
  const events = recent.map((p) => {
    const st = p.status === 'approved' ? (r() < 0.12 ? 'manual' : 'matched') : p.status === 'rejected' ? 'rejected' : p.status === 'pending' ? 'new' : 'matched';
    return [pick(activeChannels), p.customer_name, p.amount,
      `รับโอน ${Number(p.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท จาก ${p.customer_name}`,
      st, st === 'new' ? null : p.ref, new Date(new Date(p.created_at).getTime() + (5 + Math.floor(r() * 50)) * 1000)];
  });
  // Unmatched noise: transfers nobody claimed.
  for (let i = 0; i < 12; i++) {
    const amt = Math.round((200 + r() * 4000) * 100) / 100;
    events.push([pick(activeChannels), pick(['ไม่ทราบชื่อ', 'MR. TAN', 'บจก. สยามเทรด', 'นาย ก.']), amt,
      `รับโอน ${amt.toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท (ไม่พบออเดอร์ที่ตรงกัน)`, r() < 0.5 ? 'new' : 'rejected', null,
      new Date(now - Math.floor(r() * 3 * DAY))]);
  }
  await insertRows(client, 'inbound_events', ['channel_id', 'sender', 'amount', 'summary', 'status', 'payment_ref', 'received_at'], events);
  // Event detail (migration 016): receiving account, raw payload, a few ambiguous / re-checking / outgoing ones.
  await client.query(`UPDATE inbound_events e SET
      bank_account_id = p.bank_account_id,
      raw_payload = jsonb_build_object('source', 'slip', 'orderRef', p.ref, 'orderId', p.merchant_order_id, 'amount', e.amount::text,
                                       'sender', e.sender, 'receivedAt', e.received_at)
    FROM payments p WHERE p.ref = e.payment_ref`);
  await client.query(`UPDATE inbound_events SET raw_payload = jsonb_build_object('source', 'bank-alert', 'amount', amount::text, 'sender', sender),
      bank_account_id = 1, note = 'ไม่พบออเดอร์ที่ยอดตรงกันในบัญชีนี้' WHERE payment_ref IS NULL`);
  await client.query(`UPDATE inbound_events SET status = 'ambiguous', payment_ref = NULL, note = 'ยอดชนหลายออเดอร์ — เลือกออเดอร์ให้ถูก'
     WHERE id IN (SELECT id FROM inbound_events WHERE status = 'new' AND payment_ref IS NULL ORDER BY id LIMIT 2)`);
  await client.query(`UPDATE inbound_events SET recheck_at = now() + interval '7 minutes', note = 'ผู้ให้บริการตรวจสลิปไม่ตอบ — นัดตรวจซ้ำ'
     WHERE id IN (SELECT id FROM inbound_events WHERE status = 'new' AND payment_ref IS NULL ORDER BY id DESC LIMIT 2)`);
  // Slips that named an order but failed verification: a person must decide.
  await client.query(`UPDATE inbound_events e SET payment_ref = p.ref, amount = p.amount, bank_account_id = p.bank_account_id,
      note = 'สลิปตรวจไม่ผ่าน — ยอด/ชื่อผู้รับไม่ตรงกับที่ระบบอ่านได้'
      FROM (SELECT ref, amount, bank_account_id, row_number() OVER (ORDER BY id DESC) rn FROM payments WHERE status = 'pending') p,
           (SELECT id, row_number() OVER (ORDER BY id) rn FROM inbound_events WHERE status = 'new' AND payment_ref IS NULL AND recheck_at IS NULL) x
     WHERE e.id = x.id AND x.rn = p.rn AND x.rn <= 3`);
  await client.query(`UPDATE inbound_events SET direction = 'out', summary = 'โอนออก ' || amount || ' บาท ไปยัง ' || sender
     WHERE id IN (SELECT id FROM inbound_events WHERE status = 'rejected' ORDER BY id LIMIT 3)`);
  await client.query(`
    UPDATE channels c SET last_event_at = e.last, events_today = e.today
      FROM (SELECT channel_id, max(received_at) AS last,
                   count(*) FILTER (WHERE (received_at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date)::int AS today
              FROM inbound_events GROUP BY channel_id) e
     WHERE e.channel_id = c.id`);

  // ----- forwarder devices -----
  await insertRows(client, 'forwarder_devices',
    ['name', 'device_uid', 'platform', 'phone_masked', 'bank_account_id', 'app_version', 'battery_pct', 'status', 'last_seen_at'], [
      ['Samsung A54 (KBANK)', 'dev_8f3a21c9', 'android', '08x-xxx-4821', 1, '2.4.1', 86, 'online', new Date(now - 40_000)],
      ['Xiaomi Redmi 12 (SCB)', 'dev_1b77e0d4', 'android', '09x-xxx-1093', 2, '2.4.1', 54, 'online', new Date(now - 95_000)],
      ['OPPO A78 (BBL)', 'dev_c02d9e51', 'android', '06x-xxx-7730', 3, '2.3.8', 12, 'offline', new Date(now - 3 * 3_600_000)],
      ['iPhone 12 (สำรอง)', 'dev_5e6f0a3b', 'ios', '08x-xxx-2208', 5, '2.2.0', null, 'disabled', new Date(now - 9 * DAY)],
    ]);

  // ----- merchant admin (migration 013): API keys, portal users, contacts, one credit correction -----
  const { createHash } = await import('node:crypto');
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const { rows: shopRows } = await client.query('SELECT id, slug, name, status FROM merchants ORDER BY id');
  const keys = [];
  const portal = [];
  for (const m of shopRows) {
    const n = m.status === 'active' ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const raw = `sk_live_${m.slug}_${i}_${Math.floor(r() * 1e12).toString(36)}`;
      keys.push([m.id, i === 0 ? 'Production' : 'Staging', raw.slice(0, 14) + '…', sha(raw), i === 1 && m.id % 2 === 0 ? 'revoked' : 'active',
        new Date(now - Math.floor(r() * 3 * DAY)), 'admin', new Date(now - (60 - m.id) * DAY)]);
    }
    portal.push([m.id, `${m.slug}.owner`, `เจ้าของ ${m.name}`, 'owner', 'active', new Date(now - Math.floor(r() * 2 * DAY))]);
    portal.push([m.id, `${m.slug}.staff`, `พนักงาน ${m.name}`, 'staff', m.status === 'active' ? 'active' : 'disabled', null]);
  }
  await insertRows(client, 'merchant_api_keys', ['merchant_id', 'label', 'key_prefix', 'key_hash', 'status', 'last_used_at', 'created_by', 'created_at'], keys);
  await insertRows(client, 'merchant_portal_users', ['merchant_id', 'username', 'full_name', 'tier', 'status', 'last_login_at'], portal);
  // Owners can sign in to the merchant API (POST /api/auth/login): <slug>@shop.example / merchant1234 (test data).
  const { hashPassword } = await import('../src/shared/password.js');
  await client.query(`UPDATE merchant_portal_users u SET email = m.slug || '@shop.example', password_hash = $1
                        FROM merchants m WHERE m.id = u.merchant_id AND u.tier = 'owner'`, [await hashPassword('merchant1234')]);
  await client.query(`UPDATE merchants SET contact_email = slug || '@shop.example', contact_phone = '02-' || lpad((id * 1234567 % 10000000)::text, 7, '0')`);
  await insertRows(client, 'merchant_credit_adjustments', ['merchant_id', 'amount', 'reason', 'balance_after', 'created_by', 'created_at'],
    [[3, 1500, 'ชดเชยค่าธรรมเนียมที่คิดเกิน', 0, 'admin', new Date(now - 4 * DAY)]]);

  await client.query(`UPDATE forwarder_devices SET channel_id = (SELECT id FROM channels WHERE channel_type = 'sms' ORDER BY id LIMIT 1),
      model = CASE id WHEN 1 THEN 'SM-A546E' WHEN 2 THEN '23053RN02A' WHEN 3 THEN 'CPH2565' ELSE 'iPhone13,2' END`);

  // ----- webhooks -----
  const { rows: merchants } = await client.query('SELECT id, slug, status FROM merchants ORDER BY id');
  await insertRows(client, 'webhook_endpoints', ['merchant_id', 'url', 'events', 'status'],
    merchants.map((m) => [m.id, `https://${m.slug}.example.com/webhooks/superpay`, ['payment.approved', 'payment.rejected', 'withdrawal.approved'], m.status === 'active' ? 'active' : 'disabled']));
  const { seal } = await import('../src/shared/secret-box.js');
  for (const m of merchants) {
    const secret = `whsec_${m.slug}_${Math.floor(r() * 1e12).toString(36)}`;
    await client.query('UPDATE webhook_endpoints SET secret_prefix = $2, secret_hash = $3, secret_enc = $4 WHERE merchant_id = $1', [
      m.id, secret.slice(0, 12) + '…', sha(secret), seal(secret),
    ]);
  }
  const { rows: endpoints } = await client.query('SELECT id, merchant_id FROM webhook_endpoints');
  const epFor = new Map(endpoints.map((e) => [e.merchant_id, e.id]));
  const FAILS = [
    [500, 'ปลายทางตอบ 500 — ระบบร้านค้าขัดข้อง แจ้งร้านให้ตรวจสอบ log ฝั่งเขา'],
    [404, 'ไม่พบ URL ปลายทาง (404) — ร้านอาจย้าย endpoint ให้แก้ URL ในการตั้งค่า'],
    [null, 'หมดเวลารอ (timeout 10s) — ระบบจะลองส่งใหม่อัตโนมัติ'],
    [401, 'ลายเซ็นไม่ถูกต้อง (401) — ร้านค้าอาจใช้ secret เก่า'],
  ];
  const deliveries = recent.filter((p) => p.merchant_id && p.status !== 'pending').map((p) => {
    const fail = r() < 0.1 ? pick(FAILS) : null;
    return [epFor.get(p.merchant_id), p.status === 'approved' ? 'payment.approved' : 'payment.rejected', p.ref,
      fail ? fail[0] : 200, fail ? 1 + Math.floor(r() * 5) : 1, fail?.[0] === null ? 10000 : 80 + Math.floor(r() * 600), fail ? fail[1] : null,
      new Date(new Date(p.created_at).getTime() + (30 + Math.floor(r() * 300)) * 1000)];
  });
  await insertRows(client, 'webhook_deliveries', ['endpoint_id', 'event', 'payment_ref', 'status_code', 'attempts', 'response_ms', 'error', 'delivered_at'], deliveries);
  // Lifecycle: 2xx = delivered; otherwise retrying until 5 attempts, then failed for good.
  await client.query(`UPDATE webhook_deliveries d SET
      state = CASE WHEN d.status_code BETWEEN 200 AND 299 THEN 'delivered' WHEN d.attempts >= 5 THEN 'failed' ELSE 'pending' END,
      next_retry_at = CASE WHEN d.status_code BETWEEN 200 AND 299 OR d.attempts >= 5 THEN NULL ELSE d.delivered_at + d.attempts * interval '5 minutes' END,
      payload = jsonb_build_object('event', d.event, 'ref', p.ref, 'orderId', p.merchant_order_id, 'amount', p.amount::text,
                                   'status', p.status, 'createdAt', p.created_at),
      response_body = CASE WHEN d.status_code BETWEEN 200 AND 299 THEN '{"ok":true}' WHEN d.status_code IS NULL THEN NULL
                           ELSE '{"error":"' || d.status_code || '"}' END
    FROM payments p WHERE p.ref = d.payment_ref`);

  // ----- telegram alerts -----
  await insertRows(client, 'alert_channels', ['name', 'chat_masked', 'events', 'status', 'last_sent_at'], [
    ['กลุ่ม Super Admin', '-100···8231', ['withdrawal.pending', 'double_credit.detected', 'device.offline', 'channel.error'], 'active', new Date(now - 12 * MINUTE)],
    ['ฝ่ายการเงิน', '-100···5517', ['withdrawal.pending', 'outflow.pending'], 'active', new Date(now - 47 * MINUTE)],
    ['แจ้งเตือนระบบ (ทดสอบ)', '@superpay_ops', ['webhook.failed', 'slip.provider_down'], 'paused', new Date(now - 6 * DAY)],
  ]);

  await client.query(`UPDATE alert_channels SET enabled = (status = 'active'), chat_ids = replace(chat_masked, '···', '00000'),
      bot_channel_id = (SELECT id FROM channels WHERE channel_type = 'telegram' ORDER BY id LIMIT 1)`);

  // ----- settings: alert thresholds (the settings page itself lives in console_config, defaults in code) -----
  await insertRows(client, 'console_settings', ['key', 'grp', 'label', 'value'], [
    ['alerts.repeat_minutes', 'แจ้งเตือน', 'ส่งซ้ำอย่างมากทุก (นาที)', '15'],
    ['alerts.slip_fail_count', 'แจ้งเตือน', 'พลาดติดกันกี่ใบก่อนแจ้ง', '3'],
    ['alerts.slip_down_minutes', 'แจ้งเตือน', 'หรือขัดข้องต่อเนื่องกี่นาที', '5'],
  ]);

  // ----- P2P: withdrawals paid straight from matching deposits -----
  const { rows: wdr } = await client.query(
    `SELECT ref, receiver_name, receiver_account, amount, status, created_at FROM withdrawal_requests
      ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 14`);
  const deposits = payments.filter((p) => p.status === 'approved').slice(-60);
  // reserved → settled (paid) or released (nothing paid); disputed when the sides disagree.
  const P2P_STATUS = { approved: 'settled', rejected: 'released', pending: 'reserved' };
  const DISPUTES = ['ลูกค้ายืนยันว่าโอนแล้ว แต่ผู้ถอนแจ้งว่ายังไม่ได้รับเงิน', 'ยอดในสลิปไม่ตรงกับยอดที่จับคู่'];
  await insertRows(client, 'p2p_matches',
    ['ref', 'withdrawal_ref', 'payment_ref', 'amount', 'receiver_name', 'receiver_account', 'status', 'dispute_reason', 'matched_at', 'settled_at', 'released_at'],
    wdr.map((w, i) => {
      const status = i === 1 || i === 6 ? 'disputed' : P2P_STATUS[w.status];
      const at = new Date(w.created_at).getTime() + 10 * MINUTE;
      return [`P2P${String(i + 1).padStart(5, '0')}`, w.ref, deposits[(i * 3) % deposits.length].ref, w.amount, w.receiver_name, w.receiver_account,
        status, status === 'disputed' ? DISPUTES[i % 2] : null, new Date(at),
        status === 'settled' ? new Date(at + 25 * MINUTE) : null, status === 'released' ? new Date(at + 40 * MINUTE) : null];
    }));

  // ----- double credits -----
  const REASONS = ['สลิปเดียวถูกใช้กับ 2 ออเดอร์', 'ลูกค้าส่งสลิปซ้ำทาง LINE และ Telegram', 'อนุมัติด้วยมือซ้ำกับระบบอัตโนมัติ', 'ยอดและเวลาโอนตรงกับออเดอร์อื่น'];
  const approved = payments.filter((p) => p.status === 'approved');
  const dc = [];
  const CONFIDENCE = ['confirmed', 'likely', 'review'];
  for (let i = 0; i < 10; i++) {
    const a = approved[approved.length - 1 - i * 9];
    const b = approved[approved.length - 2 - i * 9];
    const open = i < 6;
    const kind = open ? null : i % 2 === 0 ? 'clawback' : 'not_duplicate';
    const detected = new Date(a.created_at).getTime() + 2 * MINUTE;
    dc.push([a.merchant_id, a.ref, b.ref, a.amount, i % 2 === 0, REASONS[i % REASONS.length], open ? 'open' : 'resolved',
      kind === 'clawback' ? 'ดึงเงินคืนจากยอดร้านแล้ว' : kind ? 'ตรวจแล้วเป็นคนละรายการ' : null, open ? null : pick(approvers).username,
      new Date(detected), CONFIDENCE[i % 3], kind, pick(approvers).username, new Date(new Date(a.created_at).getTime() + MINUTE),
      `FT${String(Math.floor(r() * 1e10)).padStart(10, '0')}`, open ? null : new Date(detected + 3 * 3_600_000)]);
  }
  await insertRows(client, 'double_credits',
    ['merchant_id', 'credited_ref', 'slip_holder_ref', 'amount', 'manual_approved', 'reason', 'status', 'resolution', 'resolved_by', 'detected_at',
      'confidence', 'resolution_kind', 'approved_by', 'approved_at', 'bank_ref', 'resolved_at'], dc);

  // ----- audit log -----
  const audit = [];
  for (const p of payments.filter((x) => new Date(x.created_at).getTime() > now - 7 * DAY && x.status !== 'pending').slice(-70)) {
    const actor = pick(approvers).username;
    audit.push([actor, p.status === 'approved' ? 'payment.approve' : p.status === 'rejected' ? 'payment.reject' : 'payment.refund', 'payment', p.ref,
      `ยอด ${Number(p.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท`, ip(), new Date(new Date(p.created_at).getTime() + 3 * MINUTE)]);
  }
  for (const o of outflows.filter((x) => x.status !== 'pending').slice(-25)) {
    audit.push([pick(approvers).username, o.status === 'approved' ? 'outflow.approve' : 'outflow.reject', 'outflow', o.ref,
      `โอนให้ ${o.receiver_name}`, ip(), new Date(new Date(o.created_at).getTime() + 5 * MINUTE)]);
  }
  for (const [actor, , , at] of logins.map((l) => [profiles.find((p) => p.id === l[0]).username, l[1], null, l[2]])) {
    audit.push([actor, 'auth.login', 'session', null, 'เข้าสู่ระบบสำเร็จ', ip(), at]);
  }
  audit.push(['admin', 'settings.update', 'setting', 'slip.auto_approve', 'ปิด → เปิด', ip(), new Date(now - 3 * DAY)]);
  audit.push(['admin', 'merchant.update', 'merchant', 'siam-books', 'สถานะ: ใช้งาน → ระงับ', ip(), new Date(now - 5 * DAY)]);
  audit.push(['admin', 'role.update', 'role', 'support', 'เพิ่มสิทธิ์ payment.create', ip(), new Date(now - 8 * DAY)]);
  await insertRows(client, 'audit_logs', ['actor', 'action', 'entity', 'entity_ref', 'detail', 'ip', 'created_at'], audit);

  const counts = {};
  for (const t of CONSOLE_TABLES) counts[t] = Number((await client.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
  return counts;
}
