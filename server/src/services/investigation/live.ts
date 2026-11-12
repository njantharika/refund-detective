import type { DB } from '../../database/db.js';
import type { PayPalIntegration } from '../paypal/index.js';
import { collectEvidence } from './evidence.js';
import { computeFactSheet, type FactSheet } from './rules.js';

/**
 * Re-fetches the order, captures, refunds, disputes, app attempts and locks LIVE and recomputes the FactSheet.
 * Used by the council guardrails and by refund validate/approve, because state may have changed since the
 * investigation ran.
 */
export async function liveFactSheet(deps: { db: DB; paypal: PayPalIntegration }, target: { orderId: string | null; captureId: string | null; transactionId: string | null }): Promise<FactSheet> {
  const targetId = target.orderId ?? target.captureId ?? target.transactionId;
  if (!targetId) throw new Error('Investigation has no PayPal target');
  const c = await collectEvidence(deps, { targetId, captureId: target.captureId, complaint: '' });
  return computeFactSheet({
    order: c.order,
    targetCaptureId: c.targetCaptureId,
    refundLookups: c.refundLookups,
    disputes: c.disputes,
    appRefunds: c.appRefunds,
    locks: c.locks,
    unavailableSources: c.unavailableSources,
  });
}
