-- EasySlip usage per day (29 Oct 2026): one row per HTTP call to EasySlip's verify API, with why it was made and what it
-- answered — the admin portal's quota card shows a daily breakdown. No slip image or customer data is stored.
CREATE TABLE IF NOT EXISTS easyslip_calls (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  purpose text NOT NULL,          -- slip_api · slip_checkout · slip_admin · slip_recheck · telegram_bot · validation_report · settings_test · transfer_backfill · other
  http_status integer,            -- null = no answer (timeout / network)
  outcome text NOT NULL           -- found · not_found · pending · error
);
CREATE INDEX IF NOT EXISTS easyslip_calls_at ON easyslip_calls (at);
