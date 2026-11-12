import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { RangeQuery, resolveRange } from './transactions.js';
import { makeAiLimiter } from './investigations.js';

export function insightsRouter({ insights }: AppDeps) {
  const r = Router();
  const ai = makeAiLimiter(6);
  r.get('/', async (req, res) => res.json(await insights.metrics(resolveRange(RangeQuery.parse(req.query)))));
  r.post('/summary', ai, async (req, res) => res.json(await insights.summarize(resolveRange(RangeQuery.parse(req.query)))));
  return r;
}
