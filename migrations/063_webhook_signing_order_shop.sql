-- Rule (19 Oct 2026, every shop): callbacks are signed with the secret key of the shop that OWNS THE ORDER — a sub-shop's
-- orders with the sub-shop's own key (prismapays started verifying that way on 19 Oct 2026). New mode 'sk_live_order_shop'
-- (falls back to the nearest parent shop's key, then the whsec_ secret); it becomes the default and every endpoint uses it.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'webhook_endpoints'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%signing%' LOOP
    EXECUTE format('ALTER TABLE webhook_endpoints DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_signing_check CHECK (signing IN ('whsec', 'sk_live_derived', 'sk_live_order_shop'));
ALTER TABLE webhook_endpoints ALTER COLUMN signing SET DEFAULT 'sk_live_order_shop';
UPDATE webhook_endpoints SET signing = 'sk_live_order_shop' WHERE signing <> 'sk_live_order_shop';
