import { Router, type Request } from 'express';
import type { AppDeps } from '../app.js';
import { AppError } from '../lib/errors.js';
import { WEBHOOK_HEADERS } from '../services/paypal/paypal-webhook.service.js';

const hdrs = (req: Request) => Object.fromEntries(WEBHOOK_HEADERS.map((h) => [h, req.header(h) ?? undefined]));

export function eventsRouter({ webhooks }: AppDeps) {
  const r = Router();
  r.get('/', (_req, res) => res.json({ configured: webhooks.configured, items: webhooks.list() }));
  return r;
}

export function webhooksRouter({ webhooks }: AppDeps) {
  const r = Router();
  r.post('/paypal', async (req, res) => {
    // Without a webhook ID there is no way to verify signatures, so nothing is stored or simulated.
    if (!webhooks.configured) throw new AppError(503, 'NOT_CONFIGURED', 'Webhooks not configured: set PAYPAL_WEBHOOK_ID');
    if (!req.body || typeof req.body !== 'object') throw new AppError(400, 'INVALID_EVENT', 'Expected a JSON webhook event');
    res.json(await webhooks.receive(hdrs(req), req.body));
  });
  return r;
}
