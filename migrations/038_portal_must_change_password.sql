-- A sub-merchant's owner gets a temporary password from the parent shop: changed at first sign-in.
ALTER TABLE merchant_portal_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
