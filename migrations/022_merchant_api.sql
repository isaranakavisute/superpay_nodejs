-- Merchant REST API v1 (own tables from 002/004/011/012/013).
ALTER TABLE payments
  ALTER COLUMN payer_bank_code DROP NOT NULL,
  ADD COLUMN source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'api', 'slip', 'collect', 'event')),
  ADD COLUMN checkout_token text UNIQUE,
  ADD COLUMN description text,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN webhook_url text,
  ADD COLUMN metadata jsonb;
CREATE UNIQUE INDEX payments_merchant_order_uniq ON payments (merchant_id, merchant_order_id)
  WHERE merchant_id IS NOT NULL AND merchant_order_id IS NOT NULL;

-- Slip verification result (provider, transaction ref for duplicate detection).
ALTER TABLE payment_slips
  ADD COLUMN provider text,
  ADD COLUMN trans_ref text,
  ADD COLUMN verify_result jsonb;
CREATE UNIQUE INDEX payment_slips_trans_ref_uniq ON payment_slips (trans_ref) WHERE trans_ref IS NOT NULL;

-- Payouts created through the API.
ALTER TABLE outflows
  ADD COLUMN merchant_ref text,
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX outflows_merchant_ref_uniq ON outflows (merchant_id, merchant_ref) WHERE merchant_ref IS NOT NULL;
CREATE UNIQUE INDEX outflows_idempotency_uniq ON outflows (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX withdrawal_requests_merchant_ref_uniq ON withdrawal_requests (merchant_id, merchant_ref) WHERE merchant_ref IS NOT NULL;

-- Receiving accounts: PromptPay id for QR, optional owner shop (NULL = central/house account).
ALTER TABLE bank_accounts
  ADD COLUMN promptpay_id text,
  ADD COLUMN merchant_id integer REFERENCES merchants (id) ON DELETE SET NULL;

-- Merchant login for POST /api/auth/login (scrypt hash; lockout after 5 failures).
ALTER TABLE merchant_portal_users
  ADD COLUMN email text,
  ADD COLUMN password_hash text,
  ADD COLUMN failed_logins integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;
CREATE UNIQUE INDEX merchant_portal_users_email_uniq ON merchant_portal_users (lower(email)) WHERE email IS NOT NULL;

-- Keys issued by the login endpoint are replaced on every login; portal keys are not.
ALTER TABLE merchant_api_keys ADD COLUMN source text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'login'));
