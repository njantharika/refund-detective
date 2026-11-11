import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppDeps } from '../app.js';

const CreateBody = z.object({
  targetId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'targetId must be a PayPal order, capture or transaction ID'),
  captureId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
  complaint: z.string().trim().min(3, 'Describe the complaint (at least 3 characters)').max(4000),
});
const ChatBody = z.object({ message: z.string().trim().min(1).max(2000) });
const IdParam = z.object({ id: z.string().regex(/^inv_[a-f0-9]{12}$/, 'Invalid investigation id') });

/** AI endpoints are rate limited per client to protect the provider quota. */
export const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many AI requests. Try again in a minute.' } }),
});

export function investigationsRouter({ investigations }: AppDeps) {
  const r = Router();
  r.post('/', aiLimiter, (req, res) => {
    const body = CreateBody.parse(req.body);
    res.status(202).json(investigations.create(body));
  });
  r.get('/', (_req, res) => res.json({ items: investigations.list() }));
  r.get('/:id', (req, res) => res.json(investigations.get(IdParam.parse(req.params).id)));
  r.post('/:id/refresh-evidence', aiLimiter, (req, res) => {
    const { id } = IdParam.parse(req.params);
    investigations.refresh(id);
    res.status(202).json({ id });
  });
  r.post('/:id/chat', aiLimiter, async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await investigations.chat(id, ChatBody.parse(req.body).message));
  });
  r.get('/:id/audit', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json({ items: investigations.auditTrail(id) });
  });
  return r;
}
