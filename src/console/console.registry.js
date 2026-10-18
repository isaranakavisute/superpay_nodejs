import { BALANCE_SQL } from '../shared/balance-sql.js';
import { visible } from '../shared/private-records.js';

/**
 * Read-only list resources for the admin console: GET /api/console/:resource.
 *
 * Every SQL fragment here is a fixed string; requests only choose WHICH
 * resource, which whitelisted filters, and values that are always bound as
 * parameters. Nothing from the request is ever interpolated into SQL.
 *
 *   from     FROM/JOIN clause
 *   columns  SELECT list (aliased to camelCase)
 *   order    ORDER BY
 *   time     column for the from/to window (optional)
 *   search   columns matched with ILIKE by ?q= (optional)
 *   status   expression the per-status summary groups by (optional)
 *   amount   expression summed per status in the summary (optional)
 *   sums     extra { alias: expression } summed per status (optional)
 *   filters  ?name=value → SQL expression compared with = (optional)
 *   live     condition always applied — hides soft-deleted rows (optional)
 *   hide     () => condition(s) hiding private test records from everyone but their owner (optional)
 */
export const RESOURCES = {
  payments: {
    hide: () => visible('payment', 'p.ref'),
    live: 'p.deleted_at IS NULL',
    from: `payments p
      LEFT JOIN merchants m     ON m.id = p.merchant_id
      -- No payer bank yet on API / checkout orders until they are paid.
      LEFT JOIN banks pb        ON pb.code = p.payer_bank_code
      JOIN bank_accounts a      ON a.id = p.bank_account_id
      JOIN banks ab             ON ab.code = a.bank_code`,
    columns: `p.ref, p.merchant_id AS "merchantId", m.name AS "merchantName",
      p.customer_name AS "customerName", p.payer_bank_code AS "payerBankCode", pb.name AS "payerBankName",
      p.payer_account_masked AS "payerAccountMasked",
      a.bank_code AS "accountBankCode", ab.name AS "accountBankName", a.account_name AS "accountName", a.account_no AS "accountNo",
      p.amount, p.fee, p.commission, p.currency, p.status, p.reviewed_by AS "reviewedBy", p.created_at AS "createdAt", p.checkout_token AS "checkoutToken", p.source, p.expires_at AS "expiresAt",
      p.merchant_order_id AS "merchantOrderId", p.slip_received_at AS "slipReceivedAt", p.review_note AS "reviewNote",
      p.completed_at AS "completedAt", p.refunded_amount AS "refundedAmount", p.slip_reused_ref AS "slipReusedRef",
      EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = p.id) AS "hasSlipImage",
      (SELECT s.verify_result->>'amount' FROM payment_slips s WHERE s.payment_id = p.id) AS "slipAmount",
      (SELECT s.verify_result->>'decision' FROM payment_slips s WHERE s.payment_id = p.id) AS "slipDecision",
      (SELECT t.amount - t.used FROM payment_slips s JOIN slip_transfers t ON t.trans_ref = coalesce(s.trans_ref, s.verify_result->>'transRef')
        WHERE s.payment_id = p.id) AS "slipTransferLeft",
      (SELECT string_agg(px.ref, ', ' ORDER BY u.id) FROM payment_slips s JOIN slip_transfers t ON t.trans_ref = coalesce(s.trans_ref, s.verify_result->>'transRef')
         JOIN slip_transfer_uses u ON u.transfer_id = t.id JOIN payments px ON px.id = u.payment_id
        WHERE s.payment_id = p.id AND u.payment_id <> p.id) AS "slipTransferUsedBy",
      -- The most this customer has left on earlier transfers at this shop (same name, or same full sender account) —
      -- an admin approval of a short slip takes the difference from it (slip-transfers.js coverShortfall).
      (SELECT max(t.amount - t.used) FROM slip_transfers t
         JOIN LATERAL (SELECT px.customer_name, px.metadata FROM slip_transfer_uses u JOIN payments px ON px.id = u.payment_id
                        WHERE u.transfer_id = t.id ORDER BY u.id LIMIT 1) f ON true
        WHERE t.merchant_id = p.merchant_id AND t.used > 0 AND t.amount > t.used AND t.leftover_until > now()
          AND ((length(regexp_replace(f.customer_name, '[[:space:]]', '', 'g')) >= 2 AND f.customer_name <> '-'
                AND lower(regexp_replace(f.customer_name, '[[:space:]]', '', 'g')) = lower(regexp_replace(p.customer_name, '[[:space:]]', '', 'g')))
               OR (length(f.metadata->>'senderAccountNumber') >= 8 AND f.metadata->>'senderAccountNumber' = p.metadata->>'senderAccountNumber'))) AS "customerLeftover"`,
    order: 'p.created_at DESC, p.id DESC',
    time: 'p.created_at',
    search: ['p.ref', 'p.customer_name', 'm.name', 'p.merchant_order_id'],
    status: 'p.status',
    amount: 'p.amount',
    sums: { fee: 'p.fee', commission: 'p.commission' },
    filters: {
      status: 'p.status',
      // "house" = payments not tied to a shop
      merchantId: `coalesce(p.merchant_id::text, 'house')`,
      bank: 'a.bank_code',
      slip: `(CASE WHEN p.slip_received_at IS NULL THEN 'no' ELSE 'yes' END)`,
      // Which card of the payments page a row belongs to.
      bucket: `(CASE
        WHEN p.status IN ('pending', 'expired') AND p.slip_reused_ref IS NOT NULL THEN 'dup'
        -- A slip still being re-checked automatically (bank processing / not found yet) is not for the admin yet.
        WHEN p.status IN ('pending', 'expired') AND EXISTS (SELECT 1 FROM payment_slips rs WHERE rs.payment_id = p.id AND rs.recheck_at IS NOT NULL) THEN 'waiting'
        WHEN p.status IN ('pending', 'expired') AND p.slip_received_at IS NOT NULL THEN 'review'
        WHEN p.status = 'pending' THEN 'waiting'
        WHEN p.status IN ('approved', 'refunded') THEN 'success'
        ELSE 'closed' END)`,
      // Channel group of the receiving account (all current accounts are commercial banks).
      group: `(CASE WHEN a.bank_code IN ('KBANK', 'SCB', 'BBL', 'KTB', 'TTB', 'BAY') THEN 'bank' ELSE 'other' END)`,
    },
  },

  outflows: {
    hide: () => visible('outflow', 'o.ref'),
    live: 'o.deleted_at IS NULL',
    // The deducting account can be empty until approval, hence the LEFT JOINs.
    from: `outflows o
      LEFT JOIN merchants m     ON m.id = o.merchant_id
      LEFT JOIN bank_accounts a ON a.id = o.bank_account_id
      LEFT JOIN banks ab        ON ab.code = a.bank_code
      JOIN banks rb             ON rb.code = o.receiver_bank_code`,
    columns: `o.ref, o.merchant_id AS "merchantId", m.name AS "merchantName", o.category,
      o.bank_account_id AS "bankAccountId", a.label AS "fromAccount", a.bank_code AS "fromBankCode", a.account_name AS "fromAccountName",
      o.receiver_name AS "receiverName", o.receiver_bank_code AS "receiverBankCode", rb.name AS "receiverBankName",
      o.receiver_account AS "receiverAccount", o.amount, o.fee, o.currency, o.status, o.created_at AS "createdAt",
      o.source, o.description, o.review_note AS "reviewNote", o.completed_at AS "completedAt", o.merchant_ref AS "merchantRef",
      o.admin_done AS "adminDone", o.admin_done_at AS "adminDoneAt", o.admin_done_by AS "adminDoneBy",
      EXISTS (SELECT 1 FROM outflow_slips s WHERE s.outflow_id = o.id) AS "hasSlipImage"`,
    order: 'o.created_at DESC, o.id DESC',
    sums: { fee: 'o.fee' },
    time: 'o.created_at',
    search: ['o.ref', 'o.receiver_name', 'm.name', 'o.description', 'o.merchant_ref', 'o.receiver_account'],
    status: 'o.status',
    amount: 'o.amount',
    filters: {
      status: 'o.status',
      category: 'o.category',
      merchantId: 'o.merchant_id::text',
      account: `coalesce(o.bank_account_id::text, 'none')`,
      adminDone: `(CASE WHEN o.admin_done THEN 'yes' ELSE 'no' END)`,
    },
  },

  withdrawals: {
    from: `withdrawal_requests w
      JOIN merchants m       ON m.id = w.merchant_id
      JOIN banks b           ON b.code = w.receiver_bank_code
      LEFT JOIN outflows o   ON o.id = w.outflow_id
      LEFT JOIN LATERAL (
        SELECT x.status, x.ref, x.amount FROM p2p_matches x WHERE x.withdrawal_ref = w.ref
         ORDER BY (x.status IN ('reserved', 'disputed')) DESC, x.matched_at DESC LIMIT 1) px ON true
      LEFT JOIN LATERAL (
        SELECT ${BALANCE_SQL} AS balance) bal ON true`,
    columns: `w.ref, w.merchant_id AS "merchantId", m.name AS "merchantName", w.merchant_ref AS "merchantRef",
      w.receiver_name AS "receiverName", w.receiver_bank_code AS "receiverBankCode", b.name AS "receiverBankName",
      w.receiver_account AS "receiverAccount", w.amount, w.fee, w.note, w.status, w.approved_by AS "approvedBy",
      w.reject_reason AS "rejectReason", o.ref AS "outflowRef", o.status AS "outflowStatus",
      EXISTS (SELECT 1 FROM outflow_slips s WHERE s.outflow_id = o.id) AS "hasSlipImage",
      px.status AS "p2pStatus", px.ref AS "p2pRef", bal.balance AS "merchantBalance", m.min_balance AS "merchantMinBalance",
      w.created_at AS "createdAt", w.decided_at AS "decidedAt"`,
    order: 'w.created_at DESC, w.id DESC',
    time: 'w.created_at',
    search: ['w.ref', 'w.receiver_name', 'm.name', 'w.merchant_ref'],
    status: 'w.status',
    amount: 'w.amount',
    filters: {
      status: 'w.status',
      merchantId: 'w.merchant_id::text',
      bucket: `(CASE
        WHEN w.status = 'rejected' THEN 'rejected'
        WHEN w.status = 'pending' AND px.status = 'reserved' THEN 'p2p'
        WHEN w.status = 'pending' THEN 'action'
        WHEN o.status = 'rejected' THEN 'action'
        WHEN o.status = 'approved' THEN 'done'
        ELSE 'awaiting' END)`,
    },
  },

  accounts: {
    hide: () => visible('account', 'a.id'),
    live: 'a.deleted_at IS NULL',
    // Balance and counts run from counters_reset_at (NULL = since the beginning).
    from: `bank_accounts a
      JOIN banks b ON b.code = a.bank_code
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS total, max(created_at) AS last_at
          FROM payments
         WHERE bank_account_id = a.id AND status = 'approved'
           AND (a.counters_reset_at IS NULL OR created_at >= a.counters_reset_at)) pin ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS total
          FROM outflows
         WHERE bank_account_id = a.id AND status = 'approved'
           AND (a.counters_reset_at IS NULL OR created_at >= a.counters_reset_at)) pout ON true`,
    columns: `a.id, a.label, a.bank_code AS "bankCode", b.name AS "bankName", a.account_name AS "accountName",
      a.account_no AS "accountNo", a.account_type AS "accountType", a.status,
      pin.n AS "inCount", pin.total AS "receivedTotal", pin.last_at AS "lastPaymentAt",
      pout.n AS "outCount", pout.total AS "sentTotal", (a.balance_at_reset + pin.total - pout.total) AS balance, a.balance_at_reset AS "balanceAtReset",
      a.counters_reset_at AS "countersResetAt", a.created_at AS "createdAt", a.promptpay_id AS "promptpayId", a.merchant_id AS "merchantId",
      (SELECT coalesce(array_agg(l.merchant_id ORDER BY l.merchant_id), '{}') FROM bank_account_merchants l WHERE l.bank_account_id = a.id) AS "merchantIds",
      (SELECT coalesce(json_agg(x ORDER BY x.total DESC), '[]') FROM (
         SELECT p.merchant_id AS "merchantId", count(*)::int AS n, sum(p.amount) AS total FROM payments p
          WHERE p.bank_account_id = a.id AND p.status = 'approved' AND (a.counters_reset_at IS NULL OR p.created_at >= a.counters_reset_at)
          GROUP BY p.merchant_id) x) AS "byShop"`,
    order: 'a.id',
    search: ['a.label', 'a.account_name', 'a.account_no', 'a.bank_code', 'b.name'],
    status: 'a.account_type',
    filters: { status: 'a.status', type: 'a.account_type' },
  },

  users: {
    from: `console_user_profiles up
      JOIN user_password u  ON u.id = up.user_password_id
      JOIN console_roles r  ON r.code = up.role_code
      LEFT JOIN LATERAL (SELECT max(logged_in_at) AS at FROM console_logins l WHERE l.user_password_id = up.user_password_id) ll ON true`,
    // user_password.mypassword is deliberately never selected.
    columns: `u.id, u.myuser AS username, up.full_name AS "fullName", up.email, up.phone, up.role_code AS "roleCode",
      r.name AS "roleName", up.status, ll.at AS "lastLoginAt", up.created_at AS "createdAt", (up.totp_enabled_at IS NOT NULL) AS "twoFactor"`,
    order: 'r.sort_order, u.id',
    search: ['u.myuser', 'up.full_name', 'up.email'],
    status: 'up.status',
    filters: { status: 'up.status', role: 'up.role_code' },
  },

  'portal-users': {
    from: 'merchant_portal_users u JOIN merchants m ON m.id = u.merchant_id',
    columns: `u.id, u.username, u.full_name AS "fullName", u.tier, u.status, u.merchant_id AS "merchantId", m.name AS "merchantName", u.super_admin AS "superAdmin",
      u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt"`,
    order: 'm.name, u.id',
    search: ['u.username', 'u.full_name', 'm.name'],
    status: 'u.status',
    filters: { status: 'u.status' },
  },

  roles: {
    from: `console_roles r
      LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM console_user_profiles p WHERE p.role_code = r.code) mc ON true`,
    columns: `r.code, r.name, r.description, r.permissions, mc.n AS "memberCount"`,
    order: 'r.sort_order',
  },

  audit: {
    hide: () => [visible(['payment', 'outflow'], 'l.entity_ref'), visible('audit', 'l.id')],
    from: 'audit_logs l',
    columns: `l.id, l.actor, l.action, l.entity, l.entity_ref AS "entityRef", l.detail, l.ip, l.created_at AS "createdAt"`,
    order: 'l.created_at DESC, l.id DESC',
    time: 'l.created_at',
    search: ['l.actor', 'l.action', 'l.entity_ref', 'l.detail'],
    status: 'l.entity',
    filters: { entity: 'l.entity', actor: 'l.actor', family: `split_part(l.action, '.', 1)` },
  },

  apiLogs: {
    hide: () => visible('api_log', 'r.id'),
    from: `api_request_logs r
      LEFT JOIN merchants m ON m.id = r.merchant_id
      LEFT JOIN merchants km ON km.id = r.key_merchant_id`,
    columns: `r.id, r.created_at AS "createdAt", r.merchant_id AS "merchantId", m.name AS "merchantName",
      r.key_merchant_id AS "keyMerchantId", km.name AS "keyMerchantName", r.key_prefix AS "keyPrefix", r.key_user AS "keyUser",
      r.method, r.path, r.query, r.status, r.error_code AS "errorCode", r.duration_ms AS "durationMs", r.ip, r.user_agent AS "userAgent",
      r.source, r.actor`,
    order: 'r.created_at DESC, r.id DESC',
    time: 'r.created_at',
    search: ['r.path', 'r.query', 'r.key_prefix', 'r.ip', 'r.error_code', 'm.name', 'r.actor'],
    status: `(CASE WHEN r.status < 300 THEN 'ok' WHEN r.status < 500 THEN 'client' ELSE 'server' END)`,
    filters: {
      merchantId: 'r.merchant_id::text',
      method: 'r.method',
      source: 'r.source',
      result: `(CASE WHEN r.status < 300 THEN 'ok' WHEN r.status < 500 THEN 'client' ELSE 'server' END)`,
    },
  },

  channels: {
    live: 'c.deleted_at IS NULL',
    // Secret values never leave the backend: only which secret fields are set.
    from: 'channels c',
    columns: `c.id, c.name, c.channel_type AS "channelType", c.provider, c.account, c.events_today AS "eventsToday",
      c.status, c.enabled, c.config, c.account_ids AS "accountIds", c.endpoint_ids AS "endpointIds",
      ARRAY(SELECT jsonb_object_keys(c.secrets_enc)) AS "secretsSet",
      c.last_event_at AS "lastEventAt", c.updated_at AS "updatedAt", c.created_at AS "createdAt"`,
    order: 'c.channel_type, c.id',
    search: ['c.name', 'c.provider', 'c.account'],
    status: 'c.channel_type',
    filters: { type: 'c.channel_type', status: 'c.status' },
  },

  events: {
    from: `inbound_events e
      JOIN channels c            ON c.id = e.channel_id
      LEFT JOIN payments p       ON p.ref = e.payment_ref
      LEFT JOIN bank_accounts a  ON a.id = e.bank_account_id`,
    columns: `e.id, e.channel_id AS "channelId", c.name AS "channelName", c.channel_type AS "channelType",
      e.sender, e.amount, e.summary, e.status, e.payment_ref AS "paymentRef", p.merchant_order_id AS "orderId",
      p.amount AS "orderAmount", p.status AS "orderStatus", e.direction, e.raw_payload AS "rawPayload",
      a.label AS "accountLabel", e.note, e.recheck_at AS "recheckAt", e.decided_by AS "decidedBy", e.received_at AS "receivedAt",
      EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = p.id) AS "hasSlipImage"`,
    order: 'e.received_at DESC, e.id DESC',
    time: 'e.received_at',
    search: ['e.sender', 'e.summary', 'e.payment_ref', 'p.merchant_order_id', 'e.amount::text'],
    status: 'e.direction',
    amount: 'e.amount',
    filters: { status: 'e.status', type: 'c.channel_type', direction: 'e.direction', bucket: `(CASE
        WHEN e.status IN ('matched', 'manual', 'rejected') THEN 'done'
        WHEN e.recheck_at IS NOT NULL THEN 'recheck'
        WHEN e.status = 'ambiguous' OR e.payment_ref IS NOT NULL THEN 'review'
        ELSE 'noorder' END)` },
  },

  devices: {
    live: 'd.deleted_at IS NULL',
    // Online = reported within the last 3 minutes; 'disabled' = suspended by an admin.
    from: `forwarder_devices d
      LEFT JOIN channels c      ON c.id = d.channel_id
      LEFT JOIN bank_accounts a ON a.id = d.bank_account_id
      LEFT JOIN banks b         ON b.code = a.bank_code`,
    columns: `d.id, d.name, d.device_uid AS "deviceUid", d.platform, d.model, d.phone_masked AS "phoneMasked",
      d.channel_id AS "channelId", c.name AS "channelName", a.label AS "accountLabel", a.bank_code AS "bankCode", b.name AS "bankName",
      d.app_version AS "appVersion", d.battery_pct AS "batteryPct", d.status, d.last_seen_at AS "lastSeenAt",
      (d.status <> 'disabled' AND d.last_seen_at > now() - interval '3 minutes') AS online`,
    order: 'd.id',
    search: ['d.name', 'd.device_uid', 'd.model'],
    status: `(CASE WHEN d.status = 'disabled' THEN 'suspended' WHEN d.last_seen_at > now() - interval '3 minutes' THEN 'online' ELSE 'offline' END)`,
    filters: { channelId: 'd.channel_id::text', status: 'd.status' },
  },

  webhooks: {
    hide: () => [visible('webhook_endpoint', 'd.endpoint_id'), visible(['payment', 'outflow'], 'coalesce(d.payment_ref, d.outflow_ref)')],
    from: `webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
      JOIN merchants m         ON m.id = e.merchant_id
      LEFT JOIN payments p     ON p.ref = d.payment_ref
      LEFT JOIN outflows o     ON o.ref = d.outflow_ref`,
    columns: `d.id, m.id AS "merchantId", m.name AS "merchantName", coalesce(d.payment_ref, d.outflow_ref) AS "paymentRef",
      coalesce(p.merchant_order_id, o.merchant_ref) AS "orderId",
      d.event, e.url, d.status_code AS "statusCode", d.attempts, d.response_ms AS "responseMs", d.error, d.state,
      d.payload, d.response_body AS "responseBody", d.signature, d.next_retry_at AS "nextRetryAt", d.delivered_at AS "deliveredAt"`,
    order: 'd.delivered_at DESC, d.id DESC',
    time: 'd.delivered_at',
    search: ['d.payment_ref', 'd.outflow_ref', 'm.name', 'e.url', 'p.merchant_order_id', 'o.merchant_ref'],
    status: 'd.state',
    filters: { state: 'd.state', merchantId: 'm.id::text', event: 'd.event' },
  },

  'webhook-endpoints': {
    hide: () => visible('webhook_endpoint', 'e.id'),
    from: 'webhook_endpoints e JOIN merchants m ON m.id = e.merchant_id',
    columns: `e.id, e.merchant_id AS "merchantId", m.name AS "merchantName", e.url, e.status`,
    order: 'm.name, e.id',
    status: 'e.status',
    filters: { status: 'e.status' },
  },

  alerts: {
    live: 'a.deleted_at IS NULL',
    from: 'alert_channels a',
    columns: `a.id, a.name, a.chat_masked AS "chatMasked", a.events, a.status, a.last_sent_at AS "lastSentAt"`,
    order: 'a.id',
    status: 'a.status',
  },

  settings: {
    from: 'console_settings s',
    columns: `s.key, s.grp AS "group", s.label, s.value, s.updated_at AS "updatedAt"`,
    order: 's.grp, s.key',
    search: ['s.key', 's.label'],
  },

  p2p: {
    from: `p2p_matches x
      LEFT JOIN payments p             ON p.ref = x.payment_ref
      LEFT JOIN merchants pm           ON pm.id = p.merchant_id
      LEFT JOIN withdrawal_requests w  ON w.ref = x.withdrawal_ref
      LEFT JOIN merchants wm           ON wm.id = w.merchant_id`,
    columns: `x.ref, x.payment_ref AS "paymentRef", pm.name AS "paymentMerchant", p.status AS "paymentStatus",
      x.withdrawal_ref AS "withdrawalRef", wm.name AS "withdrawalMerchant", w.status AS "withdrawalStatus",
      x.amount, x.receiver_name AS "receiverName", x.receiver_account AS "receiverAccount", x.status,
      x.dispute_reason AS "disputeReason", x.matched_at AS "matchedAt", x.settled_at AS "settledAt", x.released_at AS "releasedAt"`,
    order: 'x.matched_at DESC, x.id DESC',
    time: 'x.matched_at',
    search: ['x.payment_ref', 'x.withdrawal_ref', 'x.receiver_name', 'x.ref'],
    status: 'x.status',
    amount: 'x.amount',
    filters: { status: 'x.status' },
  },

  // Bank transfers that paid only part of their amount (an admin approved a bigger slip): what is left, for whom,
  // and the exact order amount the shop must create to use it. Status: open / expired / used.
  'transfer-leftovers': {
    from: `(SELECT t.*, t.amount - t.used AS left_amount,
               CASE WHEN t.amount - t.used <= 0.009 THEN 'used' WHEN t.leftover_until IS NULL OR t.leftover_until < now() THEN 'expired' ELSE 'open' END AS state
          FROM slip_transfers t
         WHERE EXISTS (SELECT 1 FROM slip_transfer_uses u WHERE u.transfer_id = t.id AND u.kind IN ('partial', 'leftover'))) t
      LEFT JOIN merchants m     ON m.id = t.merchant_id
      LEFT JOIN bank_accounts a ON a.id = t.bank_account_id
      LEFT JOIN LATERAL (SELECT p.ref, p.merchant_order_id, p.customer_name FROM slip_transfer_uses u JOIN payments p ON p.id = u.payment_id
                          WHERE u.transfer_id = t.id ORDER BY u.id LIMIT 1) f ON true`,
    columns: `t.id, t.trans_ref AS "transRef", t.merchant_id AS "merchantId", m.name AS "merchantName",
      a.bank_code AS "bankCode", a.account_no AS "accountNo", a.account_name AS "accountName",
      t.transfer_at AS "transferAt", t.amount, t.used, t.left_amount AS "left", t.leftover_until AS "leftoverUntil", t.state AS status,
      f.customer_name AS "customerName", f.ref AS "firstRef", f.merchant_order_id AS "firstOrderId", t.note,
      (SELECT json_agg(json_build_object('ref', p.ref, 'orderId', p.merchant_order_id, 'amount', u.amount, 'kind', u.kind, 'at', u.created_at) ORDER BY u.id)
         FROM slip_transfer_uses u JOIN payments p ON p.id = u.payment_id WHERE u.transfer_id = t.id) AS "paidOrders"`,
    order: `CASE t.state WHEN 'open' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END, t.leftover_until ASC NULLS LAST, t.id DESC`,
    time: 't.transfer_at',
    search: ['t.trans_ref', 'm.name', 'f.customer_name', 'f.ref', 'f.merchant_order_id'],
    status: 't.state',
    amount: 't.left_amount',
    filters: { status: 't.state', merchantId: 't.merchant_id::text' },
  },

  'double-credits': {
    from: `double_credits d
      LEFT JOIN merchants m ON m.id = d.merchant_id
      LEFT JOIN payments cp ON cp.ref = d.credited_ref
      LEFT JOIN payments sp ON sp.ref = d.slip_holder_ref`,
    columns: `d.id, d.merchant_id AS "merchantId", m.name AS "merchantName", d.credited_ref AS "creditedRef",
      cp.merchant_order_id AS "creditedOrderId", cp.created_at AS "creditedCreatedAt", cp.status AS "creditedStatus",
      cp.fee AS "creditedFee", d.slip_holder_ref AS "slipHolderRef", sp.merchant_order_id AS "slipHolderOrderId",
      sp.completed_at AS "slipHolderPaidAt", d.amount, d.manual_approved AS "manualApproved", d.approved_by AS "approvedBy",
      d.approved_at AS "approvedAt", d.reason, d.bank_ref AS "bankRef", d.confidence, d.status, d.resolution,
      d.resolution_kind AS "resolutionKind", d.resolved_by AS "resolvedBy", d.resolved_at AS "resolvedAt", d.detected_at AS "detectedAt",
      EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = cp.id) AS "creditedHasSlip",
      EXISTS (SELECT 1 FROM payment_slips s WHERE s.payment_id = sp.id) AS "slipHolderHasSlip"`,
    order: 'd.detected_at DESC, d.id DESC',
    time: 'd.detected_at',
    search: ['d.credited_ref', 'd.slip_holder_ref', 'm.name', 'd.bank_ref'],
    status: 'd.status',
    amount: 'd.amount',
    filters: { status: 'd.status', merchantId: 'd.merchant_id::text', confidence: 'd.confidence' },
  },
};
