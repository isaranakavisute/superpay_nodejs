-- Agreed 18 Oct 2026: every webhook is signed with its own shop's secret key (sk_live_-derived) by default — existing
-- endpoints and new ones. A shop whose owner has no active secret key falls back to its whsec_ secret (with an alert).
ALTER TABLE webhook_endpoints ALTER COLUMN signing SET DEFAULT 'sk_live_derived';
UPDATE webhook_endpoints SET signing = 'sk_live_derived' WHERE signing <> 'sk_live_derived';
