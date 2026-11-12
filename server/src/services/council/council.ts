import { randomUUID } from 'node:crypto';
import { audit, type DB } from '../../database/db.js';
import { AIError, type AIProvider } from '../../ai/provider.js';
import type { AppConfig } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';
import type { PayPalIntegration } from '../paypal/index.js';
import type { InvestigationService } from '../investigation/investigation.service.js';
import { liveFactSheet } from '../investigation/live.js';
import type { FactSheet } from '../investigation/rules.js';
import { toMinor } from '../investigation/money.js';
import { caseFile, type CouncilContext } from './context.js';
import { ADVOCATE_SYSTEM } from './advocate.js';
import { CHALLENGER_SYSTEM } from './challenger.js';
import { JUDGE_SYSTEM } from './judge.js';
import { applyGuardrails, type GuardrailResult } from './guardrails.js';
import { ArgumentSet, JudgeVerdict, Rebuttal, checkCitations, type CheckedArgumentSet, type CouncilDecisionType, type Proposal } from './schemas.js';

export const AGENT_BUDGET_MS = 45_000;
export const COUNCIL_BUDGET_MS = 120_000;

export interface CouncilDeps {
  db: DB;
  paypal: PayPalIntegration;
  ai: AIProvider;
  cfg: Pick<AppConfig, 'AI_MODEL_ADVOCATE' | 'AI_MODEL_CHALLENGER' | 'AI_MODEL_JUDGE' | 'COUNCIL_REBUTTAL'> & { AI_FALLBACKS?: AppConfig['AI_FALLBACKS'] };
  investigations: InvestigationService;
}

type SideResult = { ok: true; data: CheckedArgumentSet; model: string } | { ok: false; error: string };

export class CouncilService {
  private running = new Map<string, Promise<void>>();
  constructor(private readonly deps: CouncilDeps) {}

  async settled(id: string) {
    await this.running.get(id);
  }

  /** Builds the proposal in code and starts the council in the background. */
  start(investigationId: string, body: { decisionType: CouncilDecisionType; amount?: string | null; disputeId?: string | null }): { deliberationId: string } {
    const inv = this.deps.investigations.get(investigationId);
    if (inv.stage !== 'ready' || !inv.report || !inv.factSheet) throw new AppError(409, 'NOT_READY', 'The investigation report must be ready before the council can run');
    if (!this.deps.ai.configured) throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI not configured');
    if (body.decisionType === 'dispute_accept' && !body.disputeId) throw new AppError(400, 'DISPUTE_REQUIRED', 'disputeId is required to debate accepting a dispute claim');
    const running = this.deps.db.prepare("SELECT id FROM deliberations WHERE investigation_id = ? AND stage NOT IN ('complete','failed')").pluck().get(investigationId);
    if (running) throw new AppError(409, 'COUNCIL_RUNNING', 'A council is already deliberating on this investigation');

    const proposal = buildProposal(body, inv.report.proposedDecision, inv.factSheet);
    const id = `del_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.deps.db
      .prepare("INSERT INTO deliberations (id, investigation_id, decision_type, proposal_json, capture_id, dispute_id, stage, stage_detail) VALUES (?,?,?,?,?,?, 'arguing', 'Advocate and Challenger are building their cases…')")
      .run(id, investigationId, body.decisionType, JSON.stringify(proposal), proposal.captureId, proposal.disputeId);
    audit(this.deps.db, { actor: 'merchant', action: 'council_requested', resourceType: 'deliberation', resourceId: id, request: { investigationId, decisionType: body.decisionType, proposal: proposal.summary } });

    const p = this.run(id, investigationId, proposal)
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        logger.error({ id, err: message }, 'council failed');
        this.deps.db.prepare("UPDATE deliberations SET stage = 'failed', error = ?, final_outcome = 'ESCALATE_TO_HUMAN', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(message, id);
        audit(this.deps.db, { actor: 'system', action: 'council_failed', resourceType: 'deliberation', resourceId: id, result: message });
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
    return { deliberationId: id };
  }

  private stage(id: string, stage: string, detail: string | null) {
    this.deps.db.prepare('UPDATE deliberations SET stage = ?, stage_detail = ? WHERE id = ?').run(stage, detail, id);
  }

  private async run(id: string, investigationId: string, proposal: Proposal) {
    const { db, ai, cfg } = this.deps;
    const deadline = Date.now() + COUNCIL_BUDGET_MS;
    const inv = this.deps.investigations.get(investigationId);

    // Guardrails must judge the CURRENT state, not the state when the investigation ran.
    const factSheet = await liveFactSheet(this.deps, { orderId: inv.orderId, captureId: inv.captureId, transactionId: inv.transactionId });
    db.prepare('UPDATE deliberations SET fact_sheet_json = ? WHERE id = ?').run(JSON.stringify(factSheet), id);
    const evidence = this.deps.investigations.evidence(investigationId);
    const ctx: CouncilContext = { proposal, evidence, factSheet, report: inv.report, complaint: inv.complaint ?? '' };
    const file = caseFile(ctx);
    const evidenceIds = new Set(evidence.map((e) => e.id));

    // Round 1: isolated and parallel. Neither side sees the other's output.
    const side = async (role: 'advocate' | 'challenger'): Promise<SideResult> => {
      try {
        const out = await ai.complete({
          system: role === 'advocate' ? ADVOCATE_SYSTEM : CHALLENGER_SYSTEM,
          messages: [{ role: 'user', content: `${file}\n\nWrite your ${role === 'advocate' ? 'case FOR' : 'case AGAINST'} the proposed decision.` }],
          schema: ArgumentSet,
          schemaName: 'ArgumentSet',
          model: role === 'advocate' ? cfg.AI_MODEL_ADVOCATE : cfg.AI_MODEL_CHALLENGER,
          fallbackModel: cfg.AI_FALLBACKS?.[role] ?? null,
          timeoutMs: Math.min(AGENT_BUDGET_MS, deadline - Date.now()),
        });
        if (out.data.role !== role) throw new AIError('AI_INVALID_OUTPUT', `Expected role ${role}, got ${out.data.role}`);
        return { ok: true, data: checkCitations(out.data, evidenceIds, factSheet), model: out.model };
      } catch (e) {
        return { ok: false, error: e instanceof AIError ? `${e.code}: ${e.message}` : String(e) };
      }
    };
    const [advocate, challenger] = await Promise.all([side('advocate'), side('challenger')]);
    db.prepare('UPDATE deliberations SET advocate_json = ?, challenger_json = ? WHERE id = ?').run(JSON.stringify(advocate), JSON.stringify(challenger), id);
    for (const [role, r] of [['advocate', advocate], ['challenger', challenger]] as const) {
      audit(db, {
        actor: `ai:${role}`,
        action: r.ok ? 'argument_submitted' : 'argument_failed',
        resourceType: 'deliberation',
        resourceId: id,
        request: r.ok ? { model: r.model } : undefined,
        result: r.ok ? { thesis: r.data.thesis, arguments: r.data.arguments.length, validCitations: r.data.validCount } : r.error,
      });
    }

    // Never let the Judge rule on one side.
    if (!advocate.ok || !challenger.ok) {
      const failure = `${!advocate.ok ? `Advocate failed (${advocate.error})` : ''}${!advocate.ok && !challenger.ok ? '; ' : ''}${!challenger.ok ? `Challenger failed (${challenger.error})` : ''}`;
      return this.finish(id, investigationId, proposal, factSheet, null, applyGuardrails({ decisionType: proposal.decisionType, proposal, judge: null, factSheet, failure: `${failure}. The Judge did not rule on one side.` }));
    }

    // Optional single rebuttal round (each sees the other's round-1 case).
    let rebuttals: { advocate: Rebuttal | null; challenger: Rebuttal | null } | null = null;
    if (cfg.COUNCIL_REBUTTAL && deadline - Date.now() > 60_000) {
      this.stage(id, 'rebuttal', 'Rebuttal round…');
      const rebut = async (role: 'advocate' | 'challenger', opponent: CheckedArgumentSet) => {
        try {
          const out = await ai.complete({
            system: role === 'advocate' ? ADVOCATE_SYSTEM : CHALLENGER_SYSTEM,
            messages: [{ role: 'user', content: `${file}\n\nOpponent's case:\n${JSON.stringify(opponent)}\n\nWrite up to 4 rebuttals (role "${role}"). Same citation rules.` }],
            schema: Rebuttal,
            schemaName: 'Rebuttal',
            model: role === 'advocate' ? cfg.AI_MODEL_ADVOCATE : cfg.AI_MODEL_CHALLENGER,
            fallbackModel: cfg.AI_FALLBACKS?.[role] ?? null,
            timeoutMs: Math.min(AGENT_BUDGET_MS, deadline - Date.now() - 45_000),
          });
          return out.data;
        } catch {
          return null;
        }
      };
      const [a, c] = await Promise.all([rebut('advocate', challenger.data), rebut('challenger', advocate.data)]);
      rebuttals = { advocate: a, challenger: c };
      db.prepare('UPDATE deliberations SET rebuttals_json = ? WHERE id = ?').run(JSON.stringify(rebuttals), id);
    }

    // Judge.
    this.stage(id, 'judging', 'Judge deliberating…');
    let judge: JudgeVerdict | null = null;
    let judgeError: string | null = null;
    try {
      const out = await ai.complete({
        system: JUDGE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `${file}\n\nADVOCATE (deliberately one-sided, FOR), with code citation check:\n${JSON.stringify(advocate.data)}\n\nCHALLENGER (deliberately one-sided, AGAINST), with code citation check:\n${JSON.stringify(challenger.data)}\n\nREBUTTALS:\n${rebuttals ? JSON.stringify(rebuttals) : 'none (rebuttal round disabled)'}\n\nIssue your JudgeVerdict.`,
          },
        ],
        schema: JudgeVerdict,
        schemaName: 'JudgeVerdict',
        model: cfg.AI_MODEL_JUDGE,
        fallbackModel: cfg.AI_FALLBACKS?.judge ?? null,
        timeoutMs: Math.max(5_000, Math.min(AGENT_BUDGET_MS, deadline - Date.now())),
      });
      judge = out.data;
      audit(db, { actor: 'ai:judge', action: 'verdict_issued', resourceType: 'deliberation', resourceId: id, request: { model: out.model }, result: { verdict: judge.verdict, confidence: judge.confidence, amount: judge.decision.amount } });
    } catch (e) {
      judgeError = e instanceof AIError ? `${e.code}: ${e.message}` : String(e);
      audit(db, { actor: 'ai:judge', action: 'verdict_failed', resourceType: 'deliberation', resourceId: id, result: judgeError });
    }
    db.prepare('UPDATE deliberations SET judge_json = ? WHERE id = ?').run(JSON.stringify(judge ?? { error: judgeError }), id);

    this.stage(id, 'guardrails', 'Deterministic guardrails checking the verdict…');
    const decisionType = (db.prepare('SELECT decision_type FROM deliberations WHERE id = ?').pluck().get(id) as CouncilDecisionType) ?? 'refund';
    const g = applyGuardrails({ decisionType, proposal, judge, factSheet, failure: judgeError ? `Judge failed (${judgeError})` : null });
    return this.finish(id, investigationId, proposal, factSheet, judge, g);
  }

  private finish(id: string, investigationId: string, _proposal: Proposal, _fs: FactSheet, _judge: JudgeVerdict | null, g: GuardrailResult) {
    const { db } = this.deps;
    db.prepare(
      "UPDATE deliberations SET stage = 'complete', stage_detail = NULL, guardrail_json = ?, final_outcome = ?, executable_amount = ?, executable_currency = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(JSON.stringify(g), g.finalOutcome, g.executable?.amount ?? null, g.executable?.currency ?? null, id);
    audit(db, {
      actor: 'system',
      action: 'guardrails_applied',
      resourceType: 'deliberation',
      resourceId: id,
      request: { judgeVerdict: g.judgeVerdict },
      result: { finalOutcome: g.finalOutcome, overridden: g.overridden, reasons: g.overrideReasons, executable: g.executable },
    });
    if (g.executable || g.executableDispute) db.prepare("UPDATE investigations SET status = 'awaiting_approval', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'open'").run(investigationId);
  }

  get(investigationId: string, id: string) {
    const r = this.deps.db.prepare('SELECT * FROM deliberations WHERE id = ? AND investigation_id = ?').get(id, investigationId) as Record<string, any> | undefined;
    if (!r) throw new AppError(404, 'NOT_FOUND', `Deliberation ${id} not found`);
    return serialize(r);
  }

  list(investigationId: string) {
    return (this.deps.db.prepare('SELECT * FROM deliberations WHERE investigation_id = ? ORDER BY created_at DESC').all(investigationId) as Record<string, any>[]).map(serialize);
  }
}

const parse = (s: string | null) => (s ? JSON.parse(s) : null);

function serialize(r: Record<string, any>) {
  return {
    id: r.id as string,
    investigationId: r.investigation_id as string,
    decisionType: r.decision_type as CouncilDecisionType,
    stage: r.stage as string,
    stageDetail: r.stage_detail as string | null,
    error: r.error as string | null,
    proposal: parse(r.proposal_json) as Proposal,
    advocate: parse(r.advocate_json) as SideResult | null,
    challenger: parse(r.challenger_json) as SideResult | null,
    rebuttals: parse(r.rebuttals_json),
    judge: parse(r.judge_json),
    guardrails: parse(r.guardrail_json) as GuardrailResult | null,
    factSheet: parse(r.fact_sheet_json) as FactSheet | null,
    finalOutcome: r.final_outcome as string | null,
    executable: r.executable_amount ? { amount: r.executable_amount as string, currency: r.executable_currency as string, captureId: r.capture_id as string } : null,
    executableDispute: (parse(r.guardrail_json) as GuardrailResult | null)?.executableDispute ?? null,
    disputeId: (r.dispute_id as string | null) ?? null,
    createdAt: r.created_at as string,
    completedAt: r.completed_at as string | null,
  };
}

export type Deliberation = ReturnType<typeof serialize>;

/** The proposal is built in code: an explicit merchant amount, else the investigator's refund amount, else the full remaining amount. */
export function buildProposal(
  body: { decisionType: CouncilDecisionType; amount?: string | null; disputeId?: string | null },
  proposed: { type: Proposal['type']; amount: string | null; currency: string | null; reason: string },
  fs: FactSheet,
): Proposal {
  if (body.decisionType === 'dispute_accept') {
    return {
      decisionType: 'dispute_accept',
      type: 'dispute_accept',
      amount: null,
      currency: fs.currency,
      captureId: fs.targetCaptureId,
      disputeId: body.disputeId ?? null,
      reason: 'Merchant asked the council whether to accept the buyer claim',
      source: 'merchant',
      summary: `Accept the buyer's claim on dispute ${body.disputeId} (PayPal refunds the buyer the disputed amount; this cannot be undone)`,
    };
  }
  if (body.decisionType === 'next_action') {
    return { decisionType: 'next_action', type: proposed.type, amount: proposed.amount, currency: proposed.currency, captureId: fs.targetCaptureId, disputeId: null, reason: proposed.reason, source: 'investigator', summary: `Next action: ${proposed.type.replace(/_/g, ' ')}${proposed.amount ? ` ${proposed.amount} ${proposed.currency ?? ''}` : ''}` };
  }
  const currency = fs.currency;
  const fromMerchant = body.amount ?? null;
  const fromInvestigator = proposed.type === 'refund' ? proposed.amount : null;
  let amount = fromMerchant ?? fromInvestigator ?? fs.remainingRefundable ?? fs.capturedAmount;
  if (amount && currency) {
    try {
      toMinor(amount, currency);
    } catch {
      throw new AppError(400, 'INVALID_AMOUNT', `Invalid amount ${amount}`);
    }
  }
  amount = amount ?? null;
  const full = amount && fs.capturedAmount && amount === fs.capturedAmount;
  return {
    decisionType: 'refund',
    type: 'refund',
    amount,
    currency,
    captureId: fs.targetCaptureId,
    disputeId: null,
    reason: fromMerchant ? 'Merchant-specified refund amount' : proposed.reason || 'Investigator recommendation',
    source: fromMerchant ? 'merchant' : 'investigator',
    summary: `Refund ${amount ?? '?'} ${currency ?? ''} (${full ? 'full' : 'partial'}) on capture ${fs.targetCaptureId ?? 'unknown'}`,
  };
}
