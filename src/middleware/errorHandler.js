import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import config from '../config.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `Cannot ${req.method} ${req.path}` },
  });
}

// The unused `next` is required: Express identifies error handlers by arity.
export function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'internal_error';
  let message = 'Internal server error';
  let details;

  if (err instanceof ZodError) {
    status = 400;
    code = 'validation_error';
    message = 'Request validation failed';
    details = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
  } else if (err instanceof AppError) {
    ({ status, code, details } = err);
    message = err.message;
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'invalid_json';
    message = 'Request body is not valid JSON';
  } else if (err?.code === '23505') {
    status = 409;
    code = 'unique_violation';
    message = 'A record with these values already exists';
  } else if (err?.code === '23503') {
    status = 400;
    code = 'foreign_key_violation';
    message = 'Referenced record does not exist';
  } else if (err?.code === '23502' || err?.code === '23514') {
    status = 400;
    code = 'constraint_violation';
    message = 'Request violates a database constraint';
  }

  if (status >= 500) {
    req.log?.error({ err }, 'request failed');
  } else {
    req.log?.warn({ err: { message: err?.message, code } }, 'request rejected');
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(status >= 500 && !config.isProduction ? { stack: err?.stack } : {}),
    },
  });
}
