import type { EvidenceItem } from '../investigation/evidence.js';
import type { FactSheet } from '../investigation/rules.js';
import type { InvestigationReport } from '../investigation/schemas.js';
import { renderEvidence, renderFactSheet, untrusted } from '../investigation/prompts.js';
import type { Proposal } from './schemas.js';

export interface CouncilContext {
  proposal: Proposal;
  evidence: EvidenceItem[];
  factSheet: FactSheet;
  report: InvestigationReport | null;
  complaint: string;
}

export function proposalText(p: Proposal): string {
  return p.summary;
}

/** Shared case file. Free text is wrapped as <untrusted>; the investigator's analysis is labelled as non-evidence. */
export function caseFile(ctx: CouncilContext): string {
  const r = ctx.report;
  const analysis = r
    ? JSON.stringify({
        caseSummary: r.caseSummary,
        findings: r.findings.map((f) => ({ title: f.title, kind: f.kind, evidenceIds: f.evidenceIds })),
        likelyRootCause: { description: r.likelyRootCause.description, confidence: r.likelyRootCause.confidence },
        missingInformation: r.missingInformation,
      })
    : 'No investigator report.';
  return `PROPOSED DECISION UNDER REVIEW:
${proposalText(ctx.proposal)}
Proposal reason (${ctx.proposal.source}): ${untrusted(ctx.proposal.reason)}

Customer complaint (unverified allegation):
${untrusted(ctx.complaint)}

FactSheet (recomputed by code from LIVE PayPal data at ${ctx.factSheet.computedAt}, authoritative; cite field names in factSheetFields):
${renderFactSheet(ctx.factSheet)}

Evidence snapshot from the investigation, collected at ${ctx.evidence[0]?.provenance?.fetchedAt ?? 'unknown time'} (cite IDs in evidenceIds).
If the snapshot and the live FactSheet differ, the FactSheet reflects the current state; a difference means PayPal data changed since collection, not that either record is invented.
Note: captureCount includes declined or failed capture attempts; only targetCaptureId can be refunded.
${renderEvidence(ctx.evidence)}

Investigator's analysis (context only, NOT evidence; do not cite it as proof):
${analysis}`;
}
