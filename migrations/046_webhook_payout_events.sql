-- Payout callbacks (payout.failed when an admin rejects a payout): a delivery
-- points at either a payment or an outflow. Pending payout deliveries are
-- retried automatically (next_retry_at). Additive; tables from 004/014.
ALTER TABLE webhook_deliveries ADD COLUMN outflow_ref text;

CREATE INDEX webhook_deliveries_outflow_ref_idx ON webhook_deliveries (outflow_ref) WHERE outflow_ref IS NOT NULL;
CREATE INDEX webhook_deliveries_retry_idx ON webhook_deliveries (next_retry_at) WHERE state = 'pending';
