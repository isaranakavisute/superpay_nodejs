-- @OptionPayBot answers a slip it has already judged (valid or invalid) with that earlier result
-- instead of checking it again: keep the exact reply that was sent.
ALTER TABLE telegram_slip_checks ADD COLUMN reply_text text;
