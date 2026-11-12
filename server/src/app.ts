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
import { investigationsRouter } from './routes/investigations.js';
import { createAI, fallbackFor, modelFor, type AIProvider } from './ai/provider.js';
import { InvestigationService } from './services/investigation/investigation.service.js';
import { CouncilService } from './services/council/council.js';
import { RefundService } from './services/refund/refund.service.js';
import { refundsRouter, auditRouter } from './routes/refunds.js';
import { disputesRouter } from './routes/disputes.js';
import { eventsRouter, webhooksRouter } from './routes/events.js';
import { insightsRouter } from './routes/insights.js';
import { InsightsService } from './services/insights.service.js';
import { PayPalWebhookService } from './services/paypal/paypal-webhook.service.js';
import { DisputeResolutionService } from './services/dispute/dispute-resolution.service.js';

export interface AppDeps {
  cfg: AppConfig;
  db: DB;
  paypal: PayPalIntegration;
  explorer: ExplorerService;
  ai: AIProvider;
  investigations: InvestigationService;
  council: CouncilService;
  refunds: RefundService;
  disputes: DisputeResolutionService;
  webhooks: PayPalWebhookService;
  insights: InsightsService;
}

export function buildDeps(cfg: AppConfig, db: DB, paypal: PayPalIntegration, ai: AIProvider = createAI(cfg)): AppDeps {
  const investigations = new InvestigationService({ db, paypal, ai, model: modelFor(cfg, 'investigator'), fallbackModel: fallbackFor(cfg, 'investigator') });
  const council = new CouncilService({ db, paypal, ai, cfg, investigations });
  const refunds = new RefundService({ db, paypal, investigations, council });
  const disputes = new DisputeResolutionService({ db, paypal, ai, model: modelFor(cfg, 'investigator'), fallbackModel: fallbackFor(cfg, 'investigator'), council });
  const webhooks = new PayPalWebhookService({ db, auth: paypal.auth, webhookId: cfg.PAYPAL_WEBHOOK_ID, apiBase: cfg.PAYPAL_API_BASE });
  const explorer = new ExplorerService(db, paypal);
  const insights = new InsightsService({ db, paypal, explorer, ai, model: modelFor(cfg, 'investigator'), fallbackModel: fallbackFor(cfg, 'investigator') });
  return { cfg, db, paypal, ai, explorer, investigations, council, refunds, disputes, webhooks, insights };
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
  app.use('/api/investigations', investigationsRouter(deps));
  app.use('/api/refunds', refundsRouter(deps));
  app.use('/api/disputes', disputesRouter(deps));
  app.use('/api/events', eventsRouter(deps));
  app.use('/api/webhooks', webhooksRouter(deps));
  app.use('/api/insights', insightsRouter(deps));
  app.use('/api/audit', auditRouter(deps));

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
