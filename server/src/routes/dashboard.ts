import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { RangeQuery, resolveRange } from './transactions.js';
import { OPEN_DISPUTE_STATUSES } from '../services/paypal/paypal-dispute.service.js';
import type { NormalizedTransaction } from '../services/paypal/paypal.types.js';

const REFUND_EVENT_CODES = new Set(['T1107', 'T1106', 'T1201']);
const FAILED = new Set(['DENIED', 'DECLINED', 'FAILED', 'VOIDED', 'REVERSED']);

export function addMoney(acc: Record<string, number>, currency: string, value: string) {
  // Sum in minor units to avoid float drift (all PayPal Sandbox currencies used here have ≤2 decimals).
  acc[currency] = Math.round(((acc[currency] ?? 0) * 100 + Math.round(Number(value) * 100))) / 100;
}

export function summarize(transactions: NormalizedTransaction[], orderRefunds: { status: string | null; amount: { value: string; currency: string } | null; createdAt: string | null; id: string }[]) {
  const payments = transactions.filter((t) => !(t.eventCode && REFUND_EVENT_CODES.has(t.eventCode)));
  const searchRefunds = transactions.filter((t) => t.eventCode && REFUND_EVENT_CODES.has(t.eventCode));
  const volume: Record<string, number> = {};
  for (const t of payments) if (t.amount && (t.status === 'COMPLETED' || t.status === 'PARTIALLY_REFUNDED' || t.status === 'REFUNDED')) addMoney(volume, t.amount.currency, t.amount.value);

  const refundAmount: Record<string, number> = {};
  const seen = new Set<string>();
  const refundDays: Record<string, number> = {};
  for (const r of orderRefunds) {
    if (seen.has(r.id) || !r.amount) continue;
    seen.add(r.id);
    if (r.status === 'COMPLETED') addMoney(refundAmount, r.amount.currency, r.amount.value);
    if (r.createdAt) refundDays[r.createdAt.slice(0, 10)] = (refundDays[r.createdAt.slice(0, 10)] ?? 0) + 1;
  }
  for (const t of searchRefunds) {
    if (!t.amount || (t.transactionId && seen.has(t.transactionId))) continue;
    addMoney(refundAmount, t.amount.currency, String(Math.abs(Number(t.amount.value))));
    if (t.initiatedAt) refundDays[t.initiatedAt.slice(0, 10)] = (refundDays[t.initiatedAt.slice(0, 10)] ?? 0) + 1;
  }

  const activity: Record<string, { date: string; count: number; volume: number }> = {};
  for (const t of payments) {
    if (!t.initiatedAt) continue;
    const d = t.initiatedAt.slice(0, 10);
    activity[d] ??= { date: d, count: 0, volume: 0 };
    activity[d].count += 1;
    if (t.amount) activity[d].volume = Math.round((activity[d].volume + Number(t.amount.value)) * 100) / 100;
  }

  return {
    total: payments.length,
    successful: payments.filter((t) => t.status === 'COMPLETED' || t.status === 'PARTIALLY_REFUNDED' || t.status === 'REFUNDED').length,
    failed: payments.filter((t) => t.status && FAILED.has(t.status)).length,
    pending: payments.filter((t) => t.status === 'PENDING' || t.status === 'CREATED' || t.status === 'APPROVED' || t.status === 'PAYER_ACTION_REQUIRED').length,
    capturedVolume: volume,
    refunds: { count: seen.size + searchRefunds.filter((t) => !(t.transactionId && seen.has(t.transactionId))).length, amount: refundAmount },
    activity: Object.values(activity).sort((a, b) => a.date.localeCompare(b.date)),
    refundTrend: Object.entries(refundDays)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function dashboardRouter({ explorer, paypal, db }: AppDeps) {
  const r = Router();
  r.get('/summary', async (req, res) => {
    const q = RangeQuery.parse(req.query);
    const range = resolveRange(q);
    const snap = await explorer.snapshot(range, q.refresh === 'true');
    const kpis = summarize(snap.transactions, snap.orders.flatMap((o) => o.refunds));

    let openDisputes: number | null = null;
    let disputesError: string | null = null;
    try {
      const { disputes } = await paypal.disputes.listDisputes({});
      openDisputes = disputes.filter((d) => d.status && OPEN_DISPUTE_STATUSES.has(d.status)).length;
    } catch (e) {
      disputesError = e instanceof Error ? e.message : String(e);
    }

    const pipeline = db.prepare('SELECT status, COUNT(*) AS n FROM investigations GROUP BY status').all() as { status: string; n: number }[];
    const recent = db.prepare('SELECT actor, action, resource_type, resource_id, created_at FROM audit_log ORDER BY id DESC LIMIT 10').all();

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      dataMode: snap.transactions.length > 0 ? 'live' : 'empty',
      kpis: {
        ...kpis,
        openInvestigations: pipeline.filter((p) => p.status === 'open' || p.status === 'awaiting_approval').reduce((s, p) => s + p.n, 0),
        openDisputes,
      },
      investigationPipeline: Object.fromEntries(['open', 'awaiting_approval', 'resolved', 'closed'].map((s) => [s, pipeline.find((p) => p.status === s)?.n ?? 0])),
      recentActivity: recent,
      sources: { ...snap.sources, disputesError },
      fetchedAt: snap.fetchedAt,
    });
  });
  return r;
}
