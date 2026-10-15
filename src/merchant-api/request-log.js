import { query } from '../db/pool.js';
import logger from '../logger.js';

/**
 * Logs every /api/v1 call to api_request_logs once the response has gone out (never delays or breaks a call).
 * Stored: time, shop, key prefix + user, method, path, query, status, error code, duration, IP, user agent.
 * Never: the full key, secrets, signatures or request bodies. Rows older than 90 days are pruned now and then.
 */
const KEEP_DAYS = 90;
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

function record(source) {
  return (req, res, next) => {
    // Console: only actions (writes) — page loads (GET lists) would drown them.
    if (source === 'console' && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    return log(source, req, res, next);
  };
}

/** /api/v1 (merchant API) — every call. */
export const requestLog = record('api');
/** /api/console — admin actions (approve, reject, admin ดำเนินการ, …) with the admin's name. */
export const consoleActionLog = record('console');

function log(source, req, res, next) {
  const started = performance.now();
  // Keep the error code of a JSON error response ({ error: { code } }).
  const json = res.json.bind(res);
  res.json = (body) => { res.locals.errorCode = body?.error?.code ?? null; return json(body); };
  res.on('finish', () => {
    const m = req.merchant;
    const key = req.get('x-api-key');
    const [path, q] = req.originalUrl.split('?');
    query(
      `INSERT INTO api_request_logs (merchant_id, key_merchant_id, key_prefix, key_user, method, path, query, status, error_code, duration_ms, ip, user_agent, source, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [m?.id ?? null, m ? (m.actingParentId ?? m.id) : null, key ? `${key.slice(0, 12)}…` : null, cut(m?.keyUser, 64),
        req.method, cut(path, 300), cut(q, 1000), res.statusCode, cut(res.locals.errorCode, 64), Math.round(performance.now() - started),
        cut(req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip, 64), cut(req.get('user-agent'), 200), source, cut(req.actor, 100)],
    ).catch((err) => logger.warn({ err: err.message }, 'api request log failed'));
    if (Math.random() < 0.005) query(`DELETE FROM api_request_logs WHERE created_at < now() - make_interval(days => ${KEEP_DAYS})`).catch(() => {});
  });
  next();
}
