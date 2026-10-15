-- Payouts from the API are approved automatically (the shop's balance is charged at once); whether the Option Pay
-- team has actually made the bank transfer is tracked separately: "admin ดำเนินการ" (admin_done), admin-only.
ALTER TABLE outflows ADD COLUMN admin_done boolean NOT NULL DEFAULT false;
ALTER TABLE outflows ADD COLUMN admin_done_at timestamptz;
ALTER TABLE outflows ADD COLUMN admin_done_by text;
-- Outflows already decided before this change were handled by an admin.
UPDATE outflows SET admin_done = true, admin_done_at = completed_at, admin_done_by = 'migration' WHERE status IN ('approved', 'rejected');
CREATE INDEX outflows_admin_todo_idx ON outflows (created_at) WHERE admin_done = false;
