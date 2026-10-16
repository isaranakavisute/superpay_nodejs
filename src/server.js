import { createApp } from './app.js';
import config from './config.js';
import logger from './logger.js';
import { closePool, healthCheck } from './db/pool.js';
import { startScheduler, stopScheduler } from './telegram/announcement.service.js';
import { startWebhookRetries, stopWebhookRetries } from './webhooks/webhook.service.js';
import { startSlipRechecks, stopSlipRechecks } from './merchant-api/v1.service.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'superpayment listening');
});

try {
  await healthCheck();
  logger.info('database connection verified');
} catch (err) {
  // Start anyway: /readyz reports the outage and the pool retries per request,
  // so a slow database does not turn into a crash loop.
  logger.error({ err }, 'database unreachable at startup');
}

// ประชาสัมพันธ์ posts only from production (local dev shares the database).
if (config.isProduction) startScheduler();
// Payout callbacks that failed are re-sent from production only (local dev shares the database).
if (config.isProduction) startWebhookRetries(logger);
// Slips the bank was still processing (EasySlip slip_pending) are re-checked from production only.
if (config.isProduction) startSlipRechecks();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  stopScheduler();
  stopWebhookRetries();
  stopSlipRechecks();

  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closePool();
    clearTimeout(force);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});
