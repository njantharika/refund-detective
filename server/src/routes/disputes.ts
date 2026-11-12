import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { makeAiLimiter } from './investigations.js';

const DisputeId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid dispute id') });

export function disputesRouter({ disputes }: AppDeps) {
  const r = Router();
  const ai = makeAiLimiter();
  r.get('/', async (_req, res) => res.json(await disputes.list()));
  r.get('/:id', async (req, res) => res.json(await disputes.detail(DisputeId.parse(req.params).id)));
  r.post('/:id/summary', ai, async (req, res) => res.json(await disputes.summary(DisputeId.parse(req.params).id)));
  return r;
}
