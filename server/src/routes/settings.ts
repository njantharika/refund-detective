import { Router } from 'express';
import fs from 'node:fs';
import type { AppDeps } from '../app.js';
import { PayPalError } from '../services/paypal/paypal.types.js';
import { TRANSACTION_SEARCH_403_HINT } from '../services/paypal/paypal-transaction.service.js';
import { aiStatus } from '../ai/status.js';
import { DEMO_MODE_MESSAGE } from '../services/demo.js';

export const APP_VERSION = '0.1.0';

/** Never returns secret values: only whether each is configured. */
export function settingsRouter({ cfg, db, paypal }: AppDeps) {
  const r = Router();

  r.get('/integration-status', (_req, res) => {
    const auth = paypal.auth.status();
    const mcp = paypal.mcp?.status() ?? null;
    const dbSize = cfg.DATABASE_PATH !== ':memory:' && fs.existsSync(cfg.DATABASE_PATH) ? fs.statSync(cfg.DATABASE_PATH).size : null;
    const webhookCount = db.prepare('SELECT COUNT(*) FROM webhook_events').pluck().get() as number;
    res.json({
      appVersion: APP_VERSION,
      demoMode: auth.mode === 'none' ? { active: true, message: DEMO_MODE_MESSAGE } : null,
      paypal: {
        environment: cfg.PAYPAL_ENVIRONMENT,
        apiBase: cfg.PAYPAL_API_BASE,
        auth: { mode: auth.mode, hasToken: auth.hasToken, expiresAt: auth.expiresAt, warning: auth.warning, lastError: auth.lastError },
        mcp,
        tools: paypal.registry.discoveredTools(),
        missingAllowedTools: mcp?.state === 'ready' ? paypal.registry.missingAllowedTools() : [],
        lastCall: paypal.registry.lastCall(),
        pathUsage: paypal.registry.pathUsage(),
        restFallback: { available: auth.mode !== 'none', active: mcp?.state !== 'ready' && auth.mode !== 'none' },
      },
      ai: aiStatus(cfg),
      database: { path: cfg.DATABASE_PATH, sizeBytes: dbSize },
      webhooks: { configured: Boolean(cfg.PAYPAL_WEBHOOK_ID), received: webhookCount },
    });
  });

  /** Read-only connection test: one list_disputes and a 1-day Transaction Search. */
  r.post('/test-connection', async (_req, res) => {
    const checks: { tool: string; ok: boolean; path: string | null; durationMs: number; message: string | null; hint: string | null }[] = [];
    const now = new Date();
    const run = async (tool: string, fn: () => Promise<{ path: string }>) => {
      const t0 = Date.now();
      try {
        const out = await fn();
        checks.push({ tool, ok: true, path: out.path, durationMs: Date.now() - t0, message: null, hint: null });
      } catch (e) {
        const forbidden = e instanceof PayPalError && e.httpStatus === 403;
        checks.push({
          tool,
          ok: false,
          path: null,
          durationMs: Date.now() - t0,
          message: e instanceof Error ? e.message : String(e),
          hint: forbidden && tool === 'list_transactions' ? TRANSACTION_SEARCH_403_HINT : null,
        });
      }
    };
    await run('list_disputes', () => paypal.disputes.listDisputes({ pageSize: 1 }));
    await run('list_transactions', () =>
      paypal.registry.read('list_transactions', {
        start_date: new Date(now.getTime() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        end_date: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        page_size: 1,
      }),
    );
    res.json({ checks, at: new Date().toISOString() });
  });

  return r;
}
