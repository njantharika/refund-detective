import { randomUUID } from 'node:crypto';
import { audit, type DB } from '../../database/db.js';
import { AIError, type AIProvider } from '../../ai/provider.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';
import type { PayPalIntegration } from '../paypal/index.js';
import { collectEvidence, type EvidenceItem } from './evidence.js';
import { computeFactSheet, type FactSheet } from './rules.js';
import { runInvestigator, type InvestigatorResult } from './investigator.js';
import { ChatAnswer, type InvestigationReport } from './schemas.js';
import { CHAT_SYSTEM, investigationUserMessage, untrusted } from './prompts.js';

export type Stage = 'collecting' | 'analyzing' | 'ready' | 'failed' | 'ai_unavailable';

export interface InvestigationDeps {
  db: DB;
  paypal: PayPalIntegration;
  ai: AIProvider;
  model: string;
  fallbackModel?: string | null;
}

interface Row {
  id: string;
  transaction_id: string | null;
  order_id: string | null;
  capture_id: string | null;
  complaint: string | null;
  status: string;
  stage: Stage;
  stage_detail: string | null;
  error: string | null;
  summary: string | null;
  root_cause: string | null;
  confidence: number | null;
  report_json: string | null;
  fact_sheet_json: string | null;
  created_at: string;
  updated_at: string;
}

export class InvestigationService {
  private running = new Map<string, Promise<void>>();
  constructor(private readonly deps: InvestigationDeps) {}

  /** Starts an investigation; the pipeline runs in the background and its real stage is persisted. */
  create(input: { targetId: string; captureId?: string | null; complaint: string }): { id: string } {
    const id = `inv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.deps.db
      .prepare("INSERT INTO investigations (id, transaction_id, capture_id, complaint, status, stage, stage_detail) VALUES (?, ?, ?, ?, 'open', 'collecting', 'Collecting PayPal evidence…')")
      .run(id, input.targetId, input.captureId ?? null, input.complaint);
    audit(this.deps.db, { actor: 'merchant', action: 'investigation_requested', resourceType: 'investigation', resourceId: id, request: { targetId: input.targetId, captureId: input.captureId ?? null, complaintChars: input.complaint.length } });
    this.start(id, input);
    return { id };
  }

  /** Re-collects live evidence and re-runs the investigator for an existing investigation. */
  refresh(id: string) {
    const row = this.row(id);
    if (this.running.has(id)) throw new AppError(409, 'INVESTIGATION_RUNNING', 'This investigation is already running');
    this.deps.db.prepare('DELETE FROM evidence WHERE investigation_id = ?').run(id);
    this.deps.db.prepare('DELETE FROM investigation_messages WHERE investigation_id = ?').run(id);
    this.setStage(id, 'collecting', 'Re-collecting PayPal evidence…');
    audit(this.deps.db, { actor: 'merchant', action: 'evidence_refresh_requested', resourceType: 'investigation', resourceId: id });
    this.start(id, { targetId: row.transaction_id ?? row.capture_id ?? row.order_id!, captureId: row.capture_id, complaint: row.complaint ?? '' });
  }

  /** Test hook: resolves when the background pipeline for `id` finishes. */
  async settled(id: string) {
    await this.running.get(id);
  }

  private start(id: string, input: { targetId: string; captureId?: string | null; complaint: string }) {
    const p = this.pipeline(id, input)
      .catch((e) => {
        const message = e instanceof AIError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        logger.error({ id, err: message }, 'investigation pipeline failed');
        this.deps.db.prepare("UPDATE investigations SET stage = 'failed', stage_detail = NULL, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(message, id);
        audit(this.deps.db, { actor: 'system', action: 'investigation_failed', resourceType: 'investigation', resourceId: id, result: message });
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  private setStage(id: string, stage: Stage, detail: string | null) {
    this.deps.db.prepare("UPDATE investigations SET stage = ?, stage_detail = ?, error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(stage, detail, id);
  }

  private persistEvidence(id: string, items: EvidenceItem[]) {
    const db = this.deps.db;
    const ins = db.prepare('INSERT OR REPLACE INTO evidence (id, investigation_id, source, type, description, payload_json, observed_at, verified) VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => {
      db.prepare('DELETE FROM evidence WHERE investigation_id = ?').run(id);
      for (const e of items) ins.run(e.id, id, e.source, e.type, e.description, JSON.stringify({ original: e.original, normalized: e.normalized, provenance: e.provenance }), e.observedAt, e.verified ? 1 : 0);
    })();
  }

  private async pipeline(id: string, input: { targetId: string; captureId?: string | null; complaint: string }) {
    const { db, paypal, ai, model } = this.deps;
    // 1-2) Collect + normalize (backend, not the LLM).
    const collected = await collectEvidence({ db, paypal }, input);
    // 3) Deterministic analysis.
    const factSheet = computeFactSheet({
      order: collected.order,
      targetCaptureId: collected.targetCaptureId,
      refundLookups: collected.refundLookups,
      disputes: collected.disputes,
      appRefunds: collected.appRefunds,
      locks: collected.locks,
      unavailableSources: collected.unavailableSources,
    });
    this.persistEvidence(id, collected.items);
    db.prepare("UPDATE investigations SET order_id = ?, capture_id = ?, fact_sheet_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
      collected.order?.id ?? null,
      collected.targetCaptureId,
      JSON.stringify(factSheet),
      id,
    );
    audit(db, {
      actor: 'system',
      action: 'evidence_collected',
      resourceType: 'investigation',
      resourceId: id,
      result: { evidence: collected.items.length, unavailable: collected.unavailableSources.length, refundEligible: factSheet.refundEligible, remainingRefundable: factSheet.remainingRefundable },
    });

    // 4) LLM investigation. Without a configured provider we stop honestly; no rules dressed up as AI.
    if (!ai.configured) {
      this.setStage(id, 'ai_unavailable', 'AI not configured: evidence and FactSheet are available, but no AI report was generated.');
      return;
    }
    this.setStage(id, 'analyzing', 'Investigator reviewing evidence…');
    let result: InvestigatorResult;
    try {
      result = await runInvestigator({ db, paypal, ai, model, fallbackModel: this.deps.fallbackModel ?? null }, { evidence: collected.items, factSheet, complaint: input.complaint, onStage: (d) => this.setStage(id, 'analyzing', d) });
    } catch (e) {
      throw e instanceof AIError ? e : new AIError('AI_REQUEST_FAILED', String(e));
    }

    // 5) Persist report, any evidence added by tool calls, and audit.
    this.persistEvidence(id, result.evidence);
    const reportJson = { report: result.report, citationAudit: result.citationAudit, toolCalls: result.toolCalls, model: result.model, aiAttempts: result.aiAttempts, durationMs: result.durationMs, generatedAt: new Date().toISOString() };
    db.prepare(
      "UPDATE investigations SET stage = 'ready', stage_detail = NULL, error = NULL, summary = ?, root_cause = ?, confidence = ?, report_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(result.report.caseSummary, result.report.likelyRootCause.description, result.report.likelyRootCause.confidence, JSON.stringify(reportJson), id);
    audit(db, {
      actor: 'ai:investigator',
      action: 'report_generated',
      resourceType: 'investigation',
      resourceId: id,
      request: { model: result.model, evidence: result.evidence.length, toolCalls: result.toolCalls.map((t) => `${t.tool}:${t.status}`) },
      result: { findings: result.report.findings.length, removedUncited: result.citationAudit.removedFindings.length, confidence: result.report.likelyRootCause.confidence, proposed: result.report.proposedDecision.type },
    });
  }

  private row(id: string): Row {
    const r = this.deps.db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new AppError(404, 'NOT_FOUND', `Investigation ${id} not found`);
    return r;
  }

  evidence(id: string): EvidenceItem[] {
    return (this.deps.db.prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY id').all(id) as { id: string; source: EvidenceItem['source']; type: EvidenceItem['type']; description: string; payload_json: string; observed_at: string | null; verified: number }[]).map((e) => {
      const p = JSON.parse(e.payload_json ?? '{}');
      return { id: e.id, source: e.source, type: e.type, description: e.description, observedAt: e.observed_at, verified: !!e.verified, original: p.original ?? null, normalized: p.normalized ?? {}, provenance: p.provenance ?? null };
    });
  }

  get(id: string) {
    const r = this.row(id);
    const report = r.report_json ? JSON.parse(r.report_json) : null;
    const messages = this.deps.db.prepare('SELECT id, role, content, evidence_ids, kind, model, created_at FROM investigation_messages WHERE investigation_id = ? ORDER BY id').all(id) as {
      id: number;
      role: string;
      content: string;
      evidence_ids: string | null;
      kind: string | null;
      model: string | null;
      created_at: string;
    }[];
    return {
      id: r.id,
      transactionId: r.transaction_id,
      orderId: r.order_id,
      captureId: r.capture_id,
      complaint: r.complaint,
      status: r.status,
      stage: r.stage,
      stageDetail: r.stage_detail,
      error: r.error,
      running: this.running.has(id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      factSheet: r.fact_sheet_json ? (JSON.parse(r.fact_sheet_json) as FactSheet) : null,
      evidence: this.evidence(id).map(({ original: _o, ...e }) => e), // raw payloads stay server-side
      report: (report?.report ?? null) as InvestigationReport | null,
      citationAudit: report?.citationAudit ?? null,
      toolCalls: report?.toolCalls ?? [],
      model: report?.model ?? null,
      generatedAt: report?.generatedAt ?? null,
      messages: messages.map((m) => ({ ...m, evidenceIds: m.evidence_ids ? JSON.parse(m.evidence_ids) : [], evidence_ids: undefined })),
    };
  }

  auditTrail(id: string) {
    this.row(id);
    return this.deps.db.prepare("SELECT id, actor, action, request_summary, result_summary, created_at FROM audit_log WHERE resource_type = 'investigation' AND resource_id = ? ORDER BY id").all(id);
  }

  list(limit = 50) {
    return this.deps.db
      .prepare('SELECT id, transaction_id AS transactionId, order_id AS orderId, capture_id AS captureId, status, stage, summary, confidence, created_at AS createdAt, updated_at AS updatedAt FROM investigations ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }

  /** Follow-up questions use the same evidence; answers are citation-checked like findings. */
  async chat(id: string, message: string) {
    const inv = this.get(id);
    if (inv.stage !== 'ready' || !inv.report || !inv.factSheet) throw new AppError(409, 'NOT_READY', 'The investigation report is not ready yet');
    if (!this.deps.ai.configured) throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI not configured');
    const { db, ai, model } = this.deps;
    db.prepare("INSERT INTO investigation_messages (investigation_id, role, content) VALUES (?, 'merchant', ?)").run(id, message);
    const history = inv.messages.slice(-10).map((m) => ({ role: m.role === 'merchant' ? ('user' as const) : ('assistant' as const), content: m.role === 'merchant' ? untrusted(m.content) : m.content }));
    const context = `${investigationUserMessage({ evidence: this.evidence(id), factSheet: inv.factSheet, complaint: inv.complaint ?? '' })}\n\nInvestigation report:\n${JSON.stringify(inv.report)}`;
    let out;
    try {
      out = await ai.complete({
        system: CHAT_SYSTEM,
        messages: [{ role: 'user', content: context }, { role: 'assistant', content: '{"answer":"Understood. Ask your question.","evidenceIds":[],"kind":"unknown"}' }, ...history, { role: 'user', content: `Merchant question: ${untrusted(message)}` }],
        schema: ChatAnswer,
        schemaName: 'ChatAnswer',
        model,
        fallbackModel: this.deps.fallbackModel ?? null,
        timeoutMs: 45_000,
      });
    } catch (e) {
      if (e instanceof AIError) throw new AppError(e.code === 'AI_RATE_LIMITED' ? 429 : 502, e.code, e.message);
      throw e;
    }
    const valid = new Set(this.evidence(id).map((e) => e.id));
    const evidenceIds = out.data.evidenceIds.filter((x) => valid.has(x));
    const dropped = out.data.evidenceIds.filter((x) => !valid.has(x));
    db.prepare("INSERT INTO investigation_messages (investigation_id, role, content, evidence_ids, kind, model) VALUES (?, 'investigator', ?, ?, ?, ?)").run(id, out.data.answer, JSON.stringify(evidenceIds), out.data.kind, out.model);
    audit(db, { actor: 'ai:investigator', action: 'chat_answered', resourceType: 'investigation', resourceId: id, request: { questionChars: message.length, model: out.model }, result: { kind: out.data.kind, cited: evidenceIds.length, droppedInvalidIds: dropped.length } });
    return { answer: out.data.answer, evidenceIds, kind: out.data.kind, droppedInvalidIds: dropped, model: out.model };
  }
}
