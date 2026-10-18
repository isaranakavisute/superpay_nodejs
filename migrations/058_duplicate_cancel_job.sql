-- 23:00 (Bangkok) daily job: a same-customer, same-amount order created after that customer's earlier order was
-- PAID, with no new payment of its own, is rejected (rule agreed 17 Oct 2026). Seeded with yesterday so tonight runs.
INSERT INTO daily_jobs (job, last_run_for) VALUES ('duplicate_cancel', (now() AT TIME ZONE 'Asia/Bangkok')::date - 1)
ON CONFLICT (job) DO NOTHING;
