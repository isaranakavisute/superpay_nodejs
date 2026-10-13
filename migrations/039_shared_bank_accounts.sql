-- One receiving account may be used by several shops (not only parent → sub-merchant): a link table
-- replaces bank_accounts.merchant_id. Existing links are copied 1:1, so nothing changes until an admin
-- links a second shop. bank_accounts.merchant_id is kept (= first linked shop) for one release, for rollback.
CREATE TABLE bank_account_merchants (
  bank_account_id integer NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
  merchant_id     integer NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  linked_by       text,
  PRIMARY KEY (bank_account_id, merchant_id)
);
CREATE INDEX bank_account_merchants_merchant_idx ON bank_account_merchants (merchant_id);
INSERT INTO bank_account_merchants (bank_account_id, merchant_id, linked_by)
  SELECT id, merchant_id, 'migration' FROM bank_accounts WHERE merchant_id IS NOT NULL;
