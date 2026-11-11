import type { Investigation } from './api';

/** Markdown export of an investigation report (copy or download). Contains no raw payloads. */
export function reportMarkdown(inv: Investigation): string {
  const r = inv.report;
  const fs = inv.factSheet;
  const ev = new Map(inv.evidence.map((e) => [e.id, e]));
  const cite = (ids: string[]) => (ids.length ? ` [${ids.join(', ')}]` : '');
  const lines: string[] = [
    `# Refund Detective investigation ${inv.id}`,
    '',
    `- Environment: PayPal **Sandbox**`,
    `- Order: ${inv.orderId ?? 'Not available'} · Capture: ${inv.captureId ?? 'Not available'}`,
    `- Generated: ${inv.generatedAt ?? 'n/a'}${inv.model ? ` by ${inv.model}` : ''}`,
    '',
    '## Complaint (unverified allegation)',
    '',
    `> ${(inv.complaint ?? '').replace(/\n/g, '\n> ')}`,
    '',
  ];
  if (fs) {
    lines.push(
      '## FactSheet (computed by code from PayPal data)',
      '',
      `| Field | Value |`,
      `|---|---|`,
      `| Capture status | ${fs.captureStatus ?? 'n/a'} |`,
      `| Captured | ${fs.capturedAmount ?? 'n/a'} ${fs.currency ?? ''} |`,
      `| Refunded (completed) | ${fs.completedRefundTotal ?? 'n/a'} |`,
      `| Refunds pending | ${fs.pendingRefundTotal ?? 'n/a'} |`,
      `| Remaining refundable | ${fs.remainingRefundable ?? 'n/a'} |`,
      `| Open disputes | ${fs.openDisputes.join(', ') || 'none'} |`,
      `| Refund blockers | ${fs.refundBlockers.join('; ') || 'none'} |`,
      '',
    );
  }
  if (r) {
    lines.push('## Summary', '', r.caseSummary, '', '## Findings', '');
    for (const f of r.findings) lines.push(`- **${f.title}** (${f.kind}, ${f.severity})${cite(f.evidenceIds)}: ${f.explanation}`);
    if (inv.citationAudit?.removedFindings.length) lines.push('', `_${inv.citationAudit.removedFindings.length} uncited claim(s) removed by code._`);
    lines.push(
      '',
      '## Likely root cause',
      '',
      `${r.likelyRootCause.description}${cite(r.likelyRootCause.supportingEvidenceIds)}`,
      '',
      `Confidence (estimate, not a statistical guarantee): ${Math.round(r.likelyRootCause.confidence * 100)}%`,
    );
    if (r.likelyRootCause.limitations.length) lines.push('', 'Limitations:', ...r.likelyRootCause.limitations.map((l) => `- ${l}`));
    if (r.alternativeExplanations.length) lines.push('', '## Alternative explanations', '', ...r.alternativeExplanations.map((a) => `- ${a.description}${cite(a.evidenceIds)}`));
    if (r.missingInformation.length) lines.push('', '## Missing information', '', ...r.missingInformation.map((m) => `- ${m}`));
    const p = r.proposedDecision;
    lines.push('', '## Proposed decision (recommendation only; not executed)', '', `**${p.type}**${p.amount ? ` ${p.amount} ${p.currency ?? ''}` : ''}: ${p.reason}`);
  }
  lines.push('', '## Evidence', '', '| ID | Type | Source | Verified | Description |', '|---|---|---|---|---|');
  for (const e of ev.values()) lines.push(`| ${e.id} | ${e.type} | ${e.source} | ${e.verified ? 'yes' : 'no'} | ${e.description.replace(/\|/g, '/')} |`);
  return lines.join('\n') + '\n';
}
