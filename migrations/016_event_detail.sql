-- Inbound-event fields for the events inbox and its matcher. Own table (004).
ALTER TABLE inbound_events DROP CONSTRAINT inbound_events_status_check;
ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_status_check
  CHECK (status IN ('new', 'ambiguous', 'matched', 'rejected', 'manual'));
ALTER TABLE inbound_events
  ADD COLUMN direction        text NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'out')),
  ADD COLUMN raw_payload      jsonb,
  ADD COLUMN bank_account_id  integer REFERENCES bank_accounts (id),
  ADD COLUMN note             text,      -- why it was not matched / what the matcher saw
  ADD COLUMN recheck_at       timestamptz,
  ADD COLUMN decided_by       text;
