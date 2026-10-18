import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Private test records (migration 062): a row listed in private_records is visible in the admin console only to its
 * owner (the signed-in console account, sent by the console as x-console-user-id) and never in merchant-portal lists.
 * Console requests run inside `viewerContext`; read queries add `visible(kind, keySql)` to their WHERE.
 */
const store = new AsyncLocalStorage();

/** Express middleware for /api/console and /api/dashboard: remembers who is looking for the rest of the request. */
export function viewerContext(req, _res, next) {
  const id = Number(req.get('x-console-user-id'));
  store.run({ viewer: Number.isInteger(id) && id > 0 ? id : null }, next);
}

/** The signed-in console account for this request, or null (merchant API / portal / background jobs). */
export const currentViewer = () => store.getStore()?.viewer ?? null;

/** SQL: true unless the row is a private record of someone other than the current viewer. */
export function visible(kind, keySql, viewer = currentViewer()) {
  const v = Number.isInteger(viewer) ? String(viewer) : 'NULL';
  const kinds = (Array.isArray(kind) ? kind : [kind]).map((k) => `'${k.replace(/[^a-z_]/g, '')}'`).join(', ');
  return `NOT EXISTS (SELECT 1 FROM private_records pr WHERE pr.kind IN (${kinds}) AND pr.key = (${keySql})::text AND pr.owner_id IS DISTINCT FROM ${v})`;
}
