-- A Merchant Portal super-admin (agreed 17 Oct 2026): signs in once and may open ANY shop — parent or sub-merchant —
-- as that shop's owner (shop switcher). Its row sits on one shop (merchant_id is required) but is hidden from that
-- shop's user lists.
ALTER TABLE merchant_portal_users ADD COLUMN super_admin boolean NOT NULL DEFAULT false;
