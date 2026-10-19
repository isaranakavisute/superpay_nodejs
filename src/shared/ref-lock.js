/**
 * Serialises handing out the next running number (TXN… / OUT… / WDR…) — and nothing else.
 * Was `LOCK TABLE <t> IN SHARE ROW EXCLUSIVE MODE`, which also waited for, and then blocked, every write to the
 * table: under slip-check traffic it piled requests up, filled the connection pool and deadlocked against
 * slip_transfers row locks (19 Oct 2026). A transaction-scoped advisory lock keyed by the table leaves ordinary
 * reads / writes alone; numbers stay gap-free (max + 1 under the lock, released at commit / rollback).
 */
export async function lockRefNumbers(c, table) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ref-number:${table}`]);
}
