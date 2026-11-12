import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { CouncilDecisionType } from '../services/council/schemas.js';

const CreateBody = z.object({
  targetId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'targetId must be a PayPal order, capture or transaction ID'),
  captureId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
  complaint: z.string().trim().min(3, 'Describe the complaint (at least 3 characters)').max(4000),
});
const ChatBody = z.object({ message: z.string().trim().min(1).max(2000) });
const IdParam = z.object({ id: z.string().regex(/^inv_[a-f0-9]{12}$/, 'Invalid investigation id') });
const DelibParam = IdParam.extend({ deliberationId: z.string().regex(/^del_[a-f0-9]{12}$/, 'Invalid deliberation id') });
const RefundParam = IdParam.extend({ refundId: z.string().regex(/^rf_[a-f0-9]{12}$/, 'Invalid refund id') });
const Amount = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal like 42.00');
const CouncilBody = z.object({ decisionType: CouncilDecisionType, amount: Amount.nullish() });
const ApproveBody = z.object({
  deliberationId: z.string().regex(/^del_[a-f0-9]{12}$/),
  amount: Amount,
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().trim().min(1).max(500),
  confirmationText: z.string().max(100),
});

/** AI endpoints are rate limited per client to protect the provider quota (one limiter per app instance). */
export const makeAiLimiter = (limit = 12) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many AI requests. Try again in a minute.' } }),
  });

export function investigationsRouter({ investigations, council, refunds }: AppDeps) {
  const r = Router();
  const aiLimiter = makeAiLimiter();
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

  /* Decision Council */
  r.post('/:id/council', aiLimiter, (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.status(202).json(council.start(id, CouncilBody.parse(req.body)));
  });
  r.get('/:id/council', (req, res) => res.json({ items: council.list(IdParam.parse(req.params).id) }));
  r.get('/:id/council/:deliberationId', (req, res) => {
    const { id, deliberationId } = DelibParam.parse(req.params);
    res.json(council.get(id, deliberationId));
  });

  /* Refund resolution */
  r.post('/:id/refund/validate', async (req, res) => res.json(await refunds.validate(IdParam.parse(req.params).id)));
  r.post('/:id/refund/approve', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await refunds.approve(id, ApproveBody.parse(req.body)));
  });
  r.post('/:id/refund/:refundId/reconcile', async (req, res) => {
    const { refundId } = RefundParam.parse(req.params);
    res.json(await refunds.reconcileRow(refundId));
  });
  r.get('/:id/refunds', (req, res) => res.json({ items: refunds.forInvestigation(IdParam.parse(req.params).id) }));
  return r;
}
