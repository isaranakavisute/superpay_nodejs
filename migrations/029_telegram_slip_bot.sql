-- Telegram slip-check bot (@OptionPayBot): every slip sent to it is verified with the
-- slip provider (EasySlip) and recorded, so a slip sent twice is reported as a duplicate.
CREATE TABLE telegram_slip_checks (
  id           bigserial PRIMARY KEY,
  chat_id      text NOT NULL,
  message_id   bigint,
  from_user    text,
  result       text NOT NULL CHECK (result IN ('valid', 'invalid', 'unverified')),
  reason       text,
  trans_ref    text,
  image_sha256 text,
  qr_payload   text,
  amount       numeric(14, 2),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_slip_checks_trans_ref_idx ON telegram_slip_checks (trans_ref) WHERE trans_ref IS NOT NULL;
CREATE INDEX telegram_slip_checks_sha_idx ON telegram_slip_checks (image_sha256);
