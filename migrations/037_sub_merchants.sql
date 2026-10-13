-- Sub-merchants: any shop may create its own shops (unlimited), and those theirs — a tree.
-- parent_id = the shop that created it (NULL = top level, created by the admin);
-- path = its ancestors, root first ({} = top level) — "everything under X" is `X = ANY(path)`.
ALTER TABLE merchants
  ADD COLUMN parent_id integer REFERENCES merchants (id),
  ADD COLUMN path integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN allow_sub_merchants boolean NOT NULL DEFAULT true,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN created_by text;
UPDATE merchants SET approved_at = created_at;            -- existing shops are already approved
CREATE INDEX merchants_parent_idx ON merchants (parent_id);
CREATE INDEX merchants_path_gin ON merchants USING gin (path);
-- 'pending' = waits for the admin's approval (KYC gate) before it can take payments.
ALTER TABLE merchants DROP CONSTRAINT merchants_status_check;
ALTER TABLE merchants ADD CONSTRAINT merchants_status_check CHECK (status IN ('active', 'suspended', 'pending'));

-- Who gets each part of a fee (markup cascade): merchant_id NULL = the platform, else an ancestor
-- earning (its child's rate − its own rate). Written when the fee is set; counts once the source is approved.
CREATE TABLE fee_splits (
  id               bigserial PRIMARY KEY,
  source_kind      text NOT NULL CHECK (source_kind IN ('payment', 'outflow', 'withdrawal')),
  source_id        bigint NOT NULL,
  from_merchant_id integer NOT NULL REFERENCES merchants (id),   -- the shop the transaction belongs to
  merchant_id      integer REFERENCES merchants (id),            -- beneficiary (NULL = platform)
  amount           numeric(14, 2) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fee_splits_source_idx ON fee_splits (source_kind, source_id);
CREATE INDEX fee_splits_merchant_idx ON fee_splits (merchant_id) WHERE merchant_id IS NOT NULL;

-- Shop owners manage their sub-merchants (new permission, on for owners in the saved matrix).
UPDATE console_config SET value = jsonb_set(value, '{owner}', (value -> 'owner') || '"manage_sub_merchants"')
 WHERE section = 'merchantPerms' AND NOT (value -> 'owner') ? 'manage_sub_merchants';
