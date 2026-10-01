-- Delivery lifecycle and evidence for the webhooks page, plus a signing secret
-- the backend can actually use (AES-256-GCM, key derived from CONSOLE_API_KEY;
-- see src/shared/secret-box.js). Additive; tables from 004/013.
ALTER TABLE webhook_deliveries
  ADD COLUMN state          text NOT NULL DEFAULT 'delivered' CHECK (state IN ('delivered', 'pending', 'failed')),
  ADD COLUMN payload        jsonb,
  ADD COLUMN response_body  text,
  ADD COLUMN signature      text,
  ADD COLUMN next_retry_at  timestamptz;

ALTER TABLE webhook_endpoints ADD COLUMN secret_enc text;
