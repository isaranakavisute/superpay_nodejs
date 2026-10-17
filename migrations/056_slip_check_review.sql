-- The slip checker bot now gives the merchant API's verdict, which can be "needs an admin" (review) too.
ALTER TABLE telegram_slip_checks DROP CONSTRAINT telegram_slip_checks_result_check;
ALTER TABLE telegram_slip_checks ADD CONSTRAINT telegram_slip_checks_result_check CHECK (result IN ('valid', 'invalid', 'unverified', 'review'));
