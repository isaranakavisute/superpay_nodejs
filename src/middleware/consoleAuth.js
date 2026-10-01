import { createHash, timingSafeEqual } from 'node:crypto';
import config from '../config.js';
import { AppError, UnauthorizedError } from '../errors.js';

const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();

/**
 * Console endpoints are called only by the admin console's server, which
 * sends `x-console-key`. It also names the signed-in operator in
 * `x-console-actor`, exposed as req.actor for audit entries.
 */
export function requireConsoleKey(req, res, next) {
  if (!config.consoleApiKey) {
    return next(new AppError('Console API is not configured (CONSOLE_API_KEY)', { status: 503, code: 'console_disabled' }));
  }
  if (!timingSafeEqual(digest(req.get('x-console-key')), digest(config.consoleApiKey))) {
    return next(new UnauthorizedError('Missing or invalid console key'));
  }
  req.actor = (req.get('x-console-actor') || '').trim().slice(0, 100) || null;
  next();
}

export default requireConsoleKey;
