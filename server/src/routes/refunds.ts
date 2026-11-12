import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';

const RefundId = z.object({ id: z.string().regex(/^rf_[a-f0-9]{12}$/, 'Invalid refund id') });

export function refundsRouter({ refunds }: AppDeps) {
  const r = Router();
  r.get('/', (_req, res) => res.json({ items: refunds.list() }));
  r.get('/:id', (req, res) => res.json(refunds.result(RefundId.parse(req.params).id)));
  r.get('/:id/details', async (req, res) => res.json(await refunds.details(RefundId.parse(req.params).id)));
  return r;
}

const AuditQuery = z.object({
  resourceType: z.string().max(40).optional(),
  resourceId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function auditRouter({ db }: AppDeps) {
  const r = Router();
  r.get('/', (req, res) => {
    const q = AuditQuery.parse(req.query);
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.resourceType) (where.push('resource_type = ?'), vals.push(q.resourceType));
    if (q.resourceId) (where.push('resource_id = ?'), vals.push(q.resourceId));
    const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...vals, q.limit);
    res.json({ items: rows });
  });
  return r;
}
