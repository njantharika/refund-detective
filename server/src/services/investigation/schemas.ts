import { z } from 'zod';

export const DecisionType = z.enum(['refund', 'no_refund', 'dispute_accept', 'request_info', 'monitor']);

export const Finding = z.object({
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2000),
  evidenceIds: z.array(z.string()).max(20),
  kind: z.enum(['observed', 'inferred']),
  severity: z.enum(['low', 'medium', 'high']),
});

export const InvestigationReport = z.object({
  caseSummary: z.string().min(1).max(2000),
  customerComplaint: z.string().max(2000),
  transactionStatus: z.string().max(500),
  findings: z.array(Finding).max(15),
  likelyRootCause: z.object({
    description: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    supportingEvidenceIds: z.array(z.string()).max(20),
    limitations: z.array(z.string().max(500)).max(10),
  }),
  alternativeExplanations: z.array(z.object({ description: z.string().max(1000), evidenceIds: z.array(z.string()).max(20) })).max(8),
  missingInformation: z.array(z.string().max(500)).max(15),
  proposedDecision: z.object({
    type: DecisionType,
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    reason: z.string().max(1000),
  }),
});
export type InvestigationReport = z.infer<typeof InvestigationReport>;

export const InvestigatorTool = z.enum(['get_order', 'get_refund', 'get_dispute', 'search_events']);

/** Planning step: the investigator may request read-only lookups before writing the report. */
export const InvestigationPlan = z.object({
  needsMoreEvidence: z.boolean(),
  toolRequests: z
    .array(z.object({ tool: InvestigatorTool, id: z.string().min(1).max(64), reason: z.string().max(300) }))
    .max(6),
});
export type InvestigationPlan = z.infer<typeof InvestigationPlan>;

export const ChatAnswer = z.object({
  answer: z.string().min(1).max(3000),
  evidenceIds: z.array(z.string()).max(20),
  kind: z.enum(['observed', 'inferred', 'unknown']),
});
export type ChatAnswer = z.infer<typeof ChatAnswer>;

/* --------------------------- post-validation (code) --------------------------- */

export interface CitationAudit {
  removedFindings: { title: string; invalidIds: string[]; reason: 'uncited' | 'invalid_citation' }[];
  droppedIds: string[]; // invalid IDs removed from root cause / alternatives
}

/**
 * Strips any finding that cites a nonexistent evidence ID (or none at all), and removes invalid IDs
 * from other citation lists. The UI flags removed findings as "uncited claim removed".
 */
export function enforceCitations(report: InvestigationReport, validIds: Set<string>): { report: InvestigationReport; audit: CitationAudit } {
  const audit: CitationAudit = { removedFindings: [], droppedIds: [] };
  const findings = report.findings.filter((f) => {
    const invalid = f.evidenceIds.filter((id) => !validIds.has(id));
    if (f.evidenceIds.length === 0) {
      audit.removedFindings.push({ title: f.title, invalidIds: [], reason: 'uncited' });
      return false;
    }
    if (invalid.length) {
      audit.removedFindings.push({ title: f.title, invalidIds: invalid, reason: 'invalid_citation' });
      return false;
    }
    return true;
  });
  const keep = (ids: string[]) =>
    ids.filter((id) => {
      if (validIds.has(id)) return true;
      audit.droppedIds.push(id);
      return false;
    });
  return {
    report: {
      ...report,
      findings,
      likelyRootCause: { ...report.likelyRootCause, supportingEvidenceIds: keep(report.likelyRootCause.supportingEvidenceIds) },
      alternativeExplanations: report.alternativeExplanations.map((a) => ({ ...a, evidenceIds: keep(a.evidenceIds) })),
    },
    audit,
  };
}
