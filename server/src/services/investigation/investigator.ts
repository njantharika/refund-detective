import type { DB } from '../../database/db.js';
import type { AIProvider } from '../../ai/provider.js';
import type { PayPalIntegration } from '../paypal/index.js';
import { PayPalError } from '../paypal/paypal.types.js';
import { EvidenceBuilder, type EvidenceItem } from './evidence.js';
import type { FactSheet } from './rules.js';
import { enforceCitations, InvestigationPlan, InvestigationReport, type CitationAudit } from './schemas.js';
import { INVESTIGATOR_SYSTEM, PLANNER_SYSTEM, investigationUserMessage, renderEvidence } from './prompts.js';

export const MAX_TOOL_CALLS = 6;
export const INVESTIGATOR_BUDGET_MS = 60_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface ToolCallRecord {
  tool: string;
  id: string;
  reason: string;
  status: 'ok' | 'rejected' | 'failed';
  detail: string;
  addedEvidenceIds: string[];
  durationMs: number;
}

export interface InvestigatorResult {
  report: InvestigationReport;
  citationAudit: CitationAudit;
  evidence: EvidenceItem[]; // original + evidence added by tool calls
  toolCalls: ToolCallRecord[];
  model: string;
  aiAttempts: number;
  durationMs: number;
}

/**
 * Read-only tool execution on the investigator's behalf. Strict allowlist, at most MAX_TOOL_CALLS, and only
 * for IDs already present in the evidence, so a prompt-injected complaint cannot make it browse elsewhere.
 */
export class InvestigatorTools {
  calls: ToolCallRecord[] = [];
  private seq: number;
  constructor(
    private readonly deps: { db: DB; paypal: PayPalIntegration },
    private evidence: EvidenceItem[],
  ) {
    this.seq = evidence.length;
  }

  get all() {
    return this.evidence;
  }

  private knownIds(): Set<string> {
    const text = JSON.stringify(this.evidence.filter((e) => e.source !== 'merchant_input').map((e) => e.normalized));
    return new Set(text.match(/[A-Za-z0-9_-]{8,64}/g) ?? []);
  }


  async run(req: { tool: string; id: string; reason: string }): Promise<ToolCallRecord> {
    const t0 = Date.now();
    const rec = (status: ToolCallRecord['status'], detail: string, added: EvidenceItem[] = []): ToolCallRecord => {
      const r = { tool: req.tool, id: req.id, reason: req.reason.slice(0, 300), status, detail, addedEvidenceIds: added.map((e) => e.id), durationMs: Date.now() - t0 };
      this.calls.push(r);
      return r;
    };
    if (this.calls.length >= MAX_TOOL_CALLS) return rec('rejected', `Tool budget of ${MAX_TOOL_CALLS} calls exhausted`);
    if (!['get_order', 'get_refund', 'get_dispute', 'search_events'].includes(req.tool)) return rec('rejected', 'Tool not on the investigator allowlist');
    if (!ID_RE.test(req.id)) return rec('rejected', 'Invalid ID format');
    if (!this.knownIds().has(req.id)) return rec('rejected', 'ID does not appear in the collected evidence');

    const b = new EvidenceBuilder(undefined, this.seq);
    try {
      if (req.tool === 'get_order') {
        if (!/^[A-Z0-9]{17,32}$/.test(req.id)) return rec('rejected', 'Not an order ID');
        const r = await this.deps.paypal.transactions.getOrder(req.id);
        b.order(r.order, r.raw, r.path);
        for (const c of r.order.captures) b.capture(c, r.order.id, r.path);
      } else if (req.tool === 'get_refund') {
        const r = await this.deps.paypal.refunds.getRefund(req.id);
        b.refund(r.refund, null, r.path, 'get_refund', null);
      } else if (req.tool === 'get_dispute') {
        const r = await this.deps.paypal.disputes.getDispute(req.id);
        b.dispute(r.dispute, r.path);
      } else {
        const rows = this.deps.db
          .prepare('SELECT paypal_event_id, event_type, resource_id, event_time FROM webhook_events WHERE signature_verified = 1 AND (resource_id = ? OR related_ids LIKE ?) ORDER BY event_time LIMIT 20')
          .all(req.id, `%,${req.id},%`) as { paypal_event_id: string; event_type: string; resource_id: string; event_time: string }[];
        for (const ev of rows) {
          b.add({
            type: 'webhook_event',
            source: 'webhook_verified',
            description: `Verified webhook ${ev.event_type} for ${ev.resource_id}`,
            observedAt: ev.event_time,
            original: null,
            normalized: { eventId: ev.paypal_event_id, eventType: ev.event_type, resourceId: ev.resource_id },
            verified: true,
            provenance: { tool: 'search_events', path: 'database', fetchedAt: b.time },
          });
        }
      }
    } catch (e) {
      return rec('failed', e instanceof PayPalError ? `${e.code}: ${e.message}` : String(e));
    }
    const added = b.all();
    this.seq += added.length;
    this.evidence = [...this.evidence, ...added];
    return rec('ok', added.length ? `Added ${added.length} evidence item(s)` : 'No records found', added);
  }
}

export async function runInvestigator(deps: { db: DB; paypal: PayPalIntegration; ai: AIProvider; model: string; fallbackModel?: string | null }, input: { evidence: EvidenceItem[]; factSheet: FactSheet; complaint: string; onStage?: (detail: string) => void }): Promise<InvestigatorResult> {
  const started = Date.now();
  const deadline = started + INVESTIGATOR_BUDGET_MS;
  const tools = new InvestigatorTools(deps, input.evidence);
  let attempts = 0;
  let model = deps.model;
  const onRetry = (i: { reason: string; waitMs: number; model: string }) =>
    input.onStage?.(i.reason === 'rate_limited' ? `Waiting ${Math.ceil(i.waitMs / 1000)}s for the AI rate limit…` : `Model busy, retrying with ${i.model}…`);

  // Up to two planning rounds of read-only lookups, bounded by the tool and time budgets.
  for (let round = 0; round < 2 && tools.calls.length < MAX_TOOL_CALLS; round++) {
    const remaining = deadline - Date.now();
    if (remaining < 25_000) break; // keep enough budget for the report itself
    input.onStage?.(round === 0 ? 'Investigator reviewing evidence…' : 'Investigator checking follow-up lookups…');
    const plan = await deps.ai.complete({
      system: PLANNER_SYSTEM,
      messages: [
        { role: 'user', content: `${investigationUserMessage({ evidence: tools.all, factSheet: input.factSheet, complaint: input.complaint })}\n\nPrevious lookups: ${JSON.stringify(tools.calls.map((c) => ({ tool: c.tool, id: c.id, status: c.status, detail: c.detail })))}` },
      ],
      schema: InvestigationPlan,
      schemaName: 'InvestigationPlan',
      model: deps.model,
      fallbackModel: deps.fallbackModel ?? null,
      timeoutMs: Math.min(20_000, remaining - 20_000),
      onRetry,
    });
    attempts += plan.attempts;
    if (!plan.data.needsMoreEvidence || plan.data.toolRequests.length === 0) break;
    let added = 0;
    for (const r of plan.data.toolRequests) {
      if (tools.calls.length >= MAX_TOOL_CALLS) break;
      input.onStage?.(`Looking up ${r.tool.replace('_', ' ')} ${r.id}…`);
      added += (await tools.run(r)).addedEvidenceIds.length;
    }
    // A follow-up planning round only makes sense if the lookups changed the evidence (saves AI quota).
    if (added === 0) break;
  }

  input.onStage?.('Investigator writing the report…');
  const remaining = deadline - Date.now();
  const out = await deps.ai.complete({
    system: INVESTIGATOR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `${investigationUserMessage({ evidence: tools.all, factSheet: input.factSheet, complaint: input.complaint })}\n\nRead-only lookups performed: ${JSON.stringify(tools.calls.map((c) => ({ tool: c.tool, id: c.id, status: c.status, detail: c.detail, addedEvidenceIds: c.addedEvidenceIds })))}\n\nWrite the InvestigationReport.`,
      },
    ],
    schema: InvestigationReport,
    schemaName: 'InvestigationReport',
    model: deps.model,
    fallbackModel: deps.fallbackModel ?? null,
    timeoutMs: Math.max(5_000, remaining),
    onRetry,
  });
  attempts += out.attempts;
  model = out.model;
  const validIds = new Set(tools.all.map((e) => e.id));
  const { report, audit } = enforceCitations(out.data, validIds);
  return { report, citationAudit: audit, evidence: tools.all, toolCalls: tools.calls, model, aiAttempts: attempts, durationMs: Date.now() - started };
}

export { renderEvidence };
