-- Per-shop minimum deposit / withdrawal (user, 1 Nov 2026). NULL (the default, every shop) = not set here: the nearest
-- parent shop's value applies, else the admin setting (console_config 'limits'). 0 = explicitly no minimum for this shop.
SET lock_timeout = '10s';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS min_deposit numeric(14,2) CHECK (min_deposit >= 0);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS min_withdraw numeric(14,2) CHECK (min_withdraw >= 0);
