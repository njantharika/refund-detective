import { z } from 'zod';
import { DecisionType } from '../investigation/schemas.js';
import type { FactSheet } from '../investigation/rules.js';

export const CouncilDecisionType = z.enum(['refund', 'dispute_accept', 'next_action']);
export type CouncilDecisionType = z.infer<typeof CouncilDecisionType>;

const Amount = z.string().regex(/^\d+(\.\d{1,2})?$/);

/** What the council debates, e.g. "Refund 42.00 USD on capture X". Built in code from the investigation. */
export interface Proposal {
  decisionType: CouncilDecisionType;
  type: z.infer<typeof DecisionType>;
  amount: string | null;
  currency: string | null;
  captureId: string | null;
  disputeId: string | null;
  reason: string;
  source: 'investigator' | 'merchant';
  summary: string;
}

export const Argument = z.object({
  claim: z.string().min(1).max(600),
  kind: z.enum(['evidence', 'business_judgement', 'risk']),
  evidenceIds: z.array(z.string()).max(12),
  factSheetFields: z.array(z.string()).max(12),
  weight: z.enum(['low', 'medium', 'high']),
});

export const ArgumentSet = z.object({
  role: z.enum(['advocate', 'challenger']),
  position: z.enum(['for', 'against']),
  thesis: z.string().min(1).max(400),
  arguments: z.array(Argument).min(1).max(8),
  strongestPoint: z.string().max(600),
  saferAlternative: z
    .object({ type: z.enum(['partial_refund', 'request_info', 'wait_for_webhook', 'respond_to_dispute', 'no_refund']), amount: Amount.nullable(), rationale: z.string().max(600) })
    .nullable(),
});
export type ArgumentSet = z.infer<typeof ArgumentSet>;

export const Rebuttal = z.object({
  role: z.enum(['advocate', 'challenger']),
  rebuttals: z.array(z.object({ targetClaim: z.string().max(600), response: z.string().max(600), evidenceIds: z.array(z.string()).max(12), factSheetFields: z.array(z.string()).max(12) })).max(4),
});
export type Rebuttal = z.infer<typeof Rebuttal>;

export const Verdict = z.enum(['APPROVE', 'APPROVE_MODIFIED', 'REJECT', 'NEEDS_MORE_INFO', 'ESCALATE_TO_HUMAN']);
export type Verdict = z.infer<typeof Verdict>;

export const JudgeVerdict = z.object({
  verdict: Verdict,
  decision: z.object({ type: DecisionType, amount: Amount.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable() }),
  rationale: z.string().min(1).max(2000),
  decisiveArguments: z.array(z.object({ from: z.enum(['advocate', 'challenger']), claim: z.string().max(600), evidenceIds: z.array(z.string()).max(12) })).max(8),
  rejectedArguments: z.array(z.object({ from: z.enum(['advocate', 'challenger']), claim: z.string().max(600), whyRejected: z.enum(['uncited', 'contradicted_by_evidence', 'speculative', 'outweighed']) })).max(12),
  strongestDissent: z.string().max(800),
  confidence: z.number().min(0).max(1),
  conditions: z.array(z.string().max(300)).max(6),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/* ------------------------------ citation check ------------------------------ */

export type CitationStatus = 'valid' | 'invalid_citation' | 'uncited';

export interface CheckedArgument extends z.infer<typeof Argument> {
  citationStatus: CitationStatus;
  invalidEvidenceIds: string[];
  invalidFactSheetFields: string[];
}

export interface CheckedArgumentSet extends Omit<ArgumentSet, 'arguments'> {
  arguments: CheckedArgument[];
  validCount: number;
}

/**
 * Code-side citation check before the Judge runs. An argument citing any nonexistent evidence ID or
 * FactSheet field is `invalid_citation`; one citing nothing is `uncited`. Both are shown to the Judge
 * and rendered struck through ("uncited, ignored").
 */
export function checkCitations(set: ArgumentSet, evidenceIds: Set<string>, factSheet: FactSheet): CheckedArgumentSet {
  const fields = new Set(Object.keys(factSheet));
  const args = set.arguments.map((a) => {
    const badEv = a.evidenceIds.filter((id) => !evidenceIds.has(id));
    const badFs = a.factSheetFields.filter((f) => !fields.has(f));
    const cites = a.evidenceIds.length + a.factSheetFields.length;
    const citationStatus: CitationStatus = badEv.length || badFs.length ? 'invalid_citation' : cites === 0 ? 'uncited' : 'valid';
    return { ...a, citationStatus, invalidEvidenceIds: badEv, invalidFactSheetFields: badFs };
  });
  return { ...set, arguments: args, validCount: args.filter((a) => a.citationStatus === 'valid').length };
}
