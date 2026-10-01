import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import logger from './logger.js';
import config from './config.js';
import healthRouter from './routes/health.routes.js';
import usersRouter from './routes/users.routes.js';
import productsRouter from './routes/products.routes.js';
import dashboardRouter from './routes/dashboard.routes.js';
import authRouter from './routes/auth.routes.js';
import consoleRouter from './routes/console.routes.js';
import paymentsAdminRouter from './routes/payments-admin.routes.js';
import outflowsAdminRouter from './routes/outflows-admin.routes.js';
import withdrawalsAdminRouter from './routes/withdrawals-admin.routes.js';
import p2pAdminRouter from './routes/p2p-admin.routes.js';
import doubleCreditsAdminRouter from './routes/double-credits-admin.routes.js';
import merchantsAdminRouter from './routes/merchants-admin.routes.js';
import webhooksAdminRouter from './routes/webhooks-admin.routes.js';
import channelsAdminRouter from './routes/channels-admin.routes.js';
import eventsAdminRouter from './routes/events-admin.routes.js';
import devicesAdminRouter from './routes/devices-admin.routes.js';
import alertsAdminRouter from './routes/alerts-admin.routes.js';
import rolesAdminRouter from './routes/roles-admin.routes.js';
import usersAdminRouter from './routes/users-admin.routes.js';
import profileRouter from './routes/profile.routes.js';
import configAdminRouter from './routes/config-admin.routes.js';
import v1Router from './routes/v1.routes.js';
import portalRouter from './routes/portal.routes.js';
import accountsAdminRouter from './routes/accounts-admin.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import requireConsoleKey from './middleware/consoleAuth.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors());
  // Slip uploads carry a base64 image; every other body stays small.
  const smallJson = express.json({ limit: '1mb' });
  const slipJson = express.json({ limit: '12mb' });
  // Settings uploads (logo/favicon up to 8 MB raw) arrive base64-encoded.
  const assetJson = express.json({ limit: '12mb' });
  app.use((req, res, next) => {
    if (req.method !== 'POST') return smallJson(req, res, next);
    if (/^\/api\/console\/config\/(assets\/|slip\/demo-verify$)/.test(req.path)) return assetJson(req, res, next);
    return (/\/slip$/.test(req.path) || /^\/api\/v1\/payment\/slip\//.test(req.path) ? slipJson : smallJson)(req, res, next);
  });
  app.use(
    pinoHttp({
      logger,
      // Health probes would otherwise dominate the log.
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
      },
    }),
  );

  app.get('/', (req, res) => {
    res.json({
      service: 'superpayment',
      version: '0.1.0',
      env: config.env,
      endpoints: [
        'GET /healthz',
        'GET /readyz',
        'GET /api/products',
        'GET /api/products/categories',
        'GET /api/products/:id',
        'GET /api/users',
        'POST /api/users',
        'GET /api/users/:id',
        'PATCH /api/users/:id',
        'POST /api/auth/login',
        'GET|POST|PATCH|DELETE /api/v1/* (merchant API, X-API-Key)',
        'GET /api/dashboard/summary',
        'GET /api/dashboard/trend',
        'GET /api/dashboard/alerts',
        'GET /api/console',
        'GET /api/console/:resource',
        'POST /api/console/payments (+ /bulk, /:ref/approve|reject|refund|amount|revive, DELETE /:ref)',
      ],
    });
  });

  app.use(healthRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/products', productsRouter);
  // Merchant API: its own auth (X-API-Key), not the console key.
  app.use('/api/v1', v1Router);
  // Admin-console API: only the console's server holds the key.
  app.use('/api/auth', requireConsoleKey, authRouter);
  app.use('/api/dashboard', requireConsoleKey, dashboardRouter);
  app.use('/api/console/payments', requireConsoleKey, paymentsAdminRouter);
  app.use('/api/console/outflows', requireConsoleKey, outflowsAdminRouter);
  app.use('/api/console/withdrawals', requireConsoleKey, withdrawalsAdminRouter);
  app.use('/api/console/p2p', requireConsoleKey, p2pAdminRouter);
  app.use('/api/console/double-credits', requireConsoleKey, doubleCreditsAdminRouter);
  app.use('/api/console/merchants', requireConsoleKey, merchantsAdminRouter);
  app.use('/api/console/webhooks', requireConsoleKey, webhooksAdminRouter);
  app.use('/api/console/channels', requireConsoleKey, channelsAdminRouter);
  app.use('/api/console/events', requireConsoleKey, eventsAdminRouter);
  app.use('/api/console/devices', requireConsoleKey, devicesAdminRouter);
  app.use('/api/console/alert-bots', requireConsoleKey, alertsAdminRouter);
  app.use('/api/console/roles-admin', requireConsoleKey, rolesAdminRouter);
  app.use('/api/console/users-admin', requireConsoleKey, usersAdminRouter);
  app.use('/api/console/profile', requireConsoleKey, profileRouter);
  app.use('/api/console/config', requireConsoleKey, configAdminRouter);
  app.use('/api/console/portal', requireConsoleKey, portalRouter);
  app.use('/api/console/accounts-admin', requireConsoleKey, accountsAdminRouter);
  app.use('/api/console', requireConsoleKey, consoleRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
