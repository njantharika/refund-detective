import { z } from 'zod';
import type { DB } from '../database/db.js';
import { audit } from '../database/db.js';
import { AIError, type AIProvider } from '../ai/provider.js';
import { AppError } from '../lib/errors.js';
import type { ExplorerService } from './explorer.service.js';
import type { PayPalIntegration } from './paypal/index.js';
import { OPEN_DISPUTE_STATUSES } from './paypal/paypal-dispute.service.js';
import { summarize, verifiedAppRefunds } from '../routes/dashboard.js';
import { SAFETY_RULES } from './investigation/prompts.js';

export const InsightSummary = z.object({
  headline: z.string().min(1).max(300),
  observations: z.array(z.object({ text: z.string().max(500), metrics: z.array(z.string()).min(1).max(6) })).min(1).max(6),
  caveats: z.array(z.string().max(300)).max(4),
});

const INSIGHT_SYSTEM = `You summarise a PayPal merchant's Sandbox payment metrics for Refund Detective.
${SAFETY_RULES}
- Every observation must cite the metric keys it is based on (exact dotted keys from the metrics JSON) in "metrics".
- Use only the numbers given. Sample sizes are small Sandbox data: say so when relevant.
- Make no claims about savings, ROI, fraud prevented or business impact.`;

/** Dotted keys of a metrics object, used to verify that the AI cites metrics that actually exist. */
export function metricKeys(v: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      const key = prefix ? `${prefix}.${k}` : k;
      out.add(key);
      for (const sub of metricKeys(x, key)) out.add(sub);
    }
  }
  return out;
}

export class InsightsService {
  constructor(private readonly deps: { db: DB; paypal: PayPalIntegration; explorer: ExplorerService; ai: AIProvider; model: string; fallbackModel: string | null }) {}

  async metrics(range: { from: Date; to: Date }) {
    const { db } = this.deps;
    const snap = await this.deps.explorer.snapshot(range);
    const k = summarize(snap.transactions, [...snap.orders.flatMap((o) => o.refunds), ...verifiedAppRefunds(db)]);
    const statusDistribution: Record<string, number> = {};
    for (const t of snap.transactions.filter((t) => !t.eventCode || t.eventCode.startsWith('T00'))) statusDistribution[t.status ?? 'UNKNOWN'] = (statusDistribution[t.status ?? 'UNKNOWN'] ?? 0) + 1;
    const refundRate: Record<string, number | null> = {};
    for (const [cur, vol] of Object.entries(k.capturedVolume)) refundRate[cur] = vol > 0 ? Math.round(((k.refunds.amount[cur] ?? 0) / vol) * 1000) / 10 : null;

    let disputes: { total: number; open: number } | null = null;
    let disputesError: string | null = null;
    try {
      const d = (await this.deps.paypal.disputes.listDisputes({})).disputes;
      disputes = { total: d.length, open: d.filter((x) => x.status && OPEN_DISPUTE_STATUSES.has(x.status)).length };
    } catch (e) {
      disputesError = e instanceof Error ? e.message : String(e);
    }
    const verdicts = Object.fromEntries((db.prepare("SELECT final_outcome AS v, COUNT(*) AS n FROM deliberations WHERE stage = 'complete' GROUP BY final_outcome").all() as { v: string; n: number }[]).map((r) => [r.v, r.n]));
    const overrides = db.prepare("SELECT COUNT(*) FROM deliberations WHERE stage = 'complete' AND json_extract(guardrail_json, '$.overridden') = 1").pluck().get() as number;
    const inv = db.prepare("SELECT COUNT(*) AS n, AVG(confidence) AS c FROM investigations WHERE stage = 'ready'").get() as { n: number; c: number | null };
    const removed = db.prepare("SELECT COALESCE(SUM(json_array_length(json_extract(report_json, '$.citationAudit.removedFindings'))), 0) FROM investigations WHERE report_json IS NOT NULL").pluck().get() as number;

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      metrics: {
        payments: { total: k.total, successful: k.successful, failed: k.failed, pending: k.pending },
        capturedVolume: k.capturedVolume,
        refunds: { count: k.refunds.count, amount: k.refunds.amount, ratePercentOfCaptured: refundRate },
        statusDistribution,
        disputes,
        council: { verdicts, guardrailOverrides: overrides },
        investigations: { reportsReady: inv.n, avgRootCauseConfidence: inv.c === null ? null : Math.round(inv.c * 100) / 100, uncitedClaimsRemoved: removed },
      },
      series: { activity: k.activity, refundTrend: k.refundTrend },
      sources: { ...snap.sources, disputesError },
      latestSummary: this.latestSummary(),
      fetchedAt: snap.fetchedAt,
    };
  }

  latestSummary() {
    const r = this.deps.db.prepare('SELECT summary_json, model, created_at FROM insight_summaries ORDER BY id DESC LIMIT 1').get() as { summary_json: string; model: string; created_at: string } | undefined;
    return r ? { ...JSON.parse(r.summary_json), model: r.model, createdAt: r.created_at } : null;
  }

  /** AI summary; observations citing metric keys that don't exist are removed in code. */
  async summarize(range: { from: Date; to: Date }) {
    if (!this.deps.ai.configured) throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI not configured');
    const m = await this.metrics(range);
    const keys = metricKeys(m.metrics);
    let out;
    try {
      out = await this.deps.ai.complete({
        system: INSIGHT_SYSTEM,
        messages: [{ role: 'user', content: `Metrics JSON for ${m.range.from} to ${m.range.to}:\n${JSON.stringify(m.metrics)}` }],
        schema: InsightSummary,
        schemaName: 'InsightSummary',
        model: this.deps.model,
        fallbackModel: this.deps.fallbackModel,
        timeoutMs: 45_000,
      });
    } catch (e) {
      if (e instanceof AIError) throw new AppError(e.code === 'AI_RATE_LIMITED' ? 429 : 502, e.code, e.message);
      throw e;
    }
    const observations = out.data.observations.map((o) => ({ ...o, metrics: o.metrics.filter((x) => keys.has(x)) })).filter((o) => o.metrics.length > 0);
    const summary = { headline: out.data.headline, observations, caveats: out.data.caveats, removedUncited: out.data.observations.length - observations.length, metricsSnapshot: m.metrics };
    this.deps.db.prepare('INSERT INTO insight_summaries (range_key, summary_json, model) VALUES (?,?,?)').run(`${m.range.from}|${m.range.to}`, JSON.stringify(summary), out.model);
    audit(this.deps.db, { actor: 'ai:investigator', action: 'insights_summarized', resourceType: 'insights', resourceId: null, result: { observations: observations.length, removedUncited: summary.removedUncited, model: out.model } });
    return { ...summary, model: out.model, createdAt: new Date().toISOString() };
  }
}
