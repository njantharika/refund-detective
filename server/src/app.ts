import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import type { DB } from './database/db.js';
import type { PayPalIntegration } from './services/paypal/index.js';
import { ExplorerService } from './services/explorer.service.js';
import { errorHandler, AppError } from './lib/errors.js';
import { transactionsRouter } from './routes/transactions.js';
import { dashboardRouter } from './routes/dashboard.js';
import { settingsRouter, APP_VERSION } from './routes/settings.js';

export interface AppDeps {
  cfg: AppConfig;
  db: DB;
  paypal: PayPalIntegration;
  explorer: ExplorerService;
}

export function buildDeps(cfg: AppConfig, db: DB, paypal: PayPalIntegration): AppDeps {
  return { cfg, db, paypal, explorer: new ExplorerService(db, paypal) };
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', version: APP_VERSION, environment: deps.cfg.PAYPAL_ENVIRONMENT, time: new Date().toISOString() });
  });
  app.use('/api/settings', settingsRouter(deps));
  app.use('/api/transactions', transactionsRouter(deps));
  app.use('/api/dashboard', dashboardRouter(deps));

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Unknown API route')));

  // Serve the built client in production (single Render web service).
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
