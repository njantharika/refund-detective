import { describe, it, expect, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { InvestigationWorkspace } from '../pages/InvestigationWorkspace';
import { investigation } from '../test/fixtures';
import type { Deliberation, Investigation } from '../lib/api';
import { mockFetch, renderWithProviders } from '../test/utils';

const arg = (claim: string, status: 'valid' | 'invalid_citation' | 'uncited', ids: string[] = ['EV-002']) => ({
  claim, kind: 'evidence' as const, evidenceIds: ids, factSheetFields: ['remainingRefundable'], weight: 'high' as const, citationStatus: status, invalidEvidenceIds: status === 'invalid_citation' ? ids : [], invalidFactSheetFields: [],
});

export const deliberation = (over: Partial<Deliberation> = {}): Deliberation => ({
  id: 'del_8b210e0560b3', investigationId: 'inv_7833cb461c58', decisionType: 'refund', stage: 'complete', stageDetail: null, error: null,
  proposal: { summary: 'Refund 42.00 USD (full) on capture 0NM23031PE726202M', amount: '42.00', currency: 'USD', captureId: '0NM23031PE726202M', reason: 'x', source: 'investigator' },
  advocate: { ok: true, model: 'gemini-3.5-flash', data: { role: 'advocate', position: 'for', thesis: 'Refund is fully supported', arguments: [arg('Capture completed for 42.00', 'valid')], strongestPoint: '', saferAlternative: null, validCount: 1 } },
  challenger: { ok: true, model: 'gemini-3-flash-preview', data: { role: 'challenger', position: 'against', thesis: 'Claim is unverified', arguments: [arg('Complaint is only an allegation', 'valid', ['EV-003']), arg('Invented chargeback exists', 'invalid_citation', ['EV-999'])], strongestPoint: '', saferAlternative: { type: 'request_info', amount: null, rationale: 'Ask for proof' }, validCount: 1 } },
  rebuttals: null,
  judge: { verdict: 'APPROVE', decision: { type: 'refund', amount: '42.00', currency: 'USD' }, rationale: 'Capture completed, nothing refunded.', decisiveArguments: [{ from: 'advocate', claim: 'Capture completed for 42.00', evidenceIds: ['EV-002'] }], rejectedArguments: [], strongestDissent: 'Complaint unverified', confidence: 0.9, conditions: ['Only if no dispute opens before execution'] },
  guardrails: { judgeVerdict: 'APPROVE', finalOutcome: 'APPROVE', overridden: false, overrideReasons: [], checks: [{ rule: 'remaining_refundable', passed: true, outcome: null, detail: 'Remaining refundable 42.00 USD' }], executable: { amount: '42.00', currency: 'USD', captureId: '0NM23031PE726202M' } },
  factSheet: null, finalOutcome: 'APPROVE', executable: { amount: '42.00', currency: 'USD', captureId: '0NM23031PE726202M' }, executableDispute: null, disputeId: null, createdAt: '2026-11-12T00:00:00Z', completedAt: '2026-11-12T00:00:30Z',
  ...over,
});

const eligibility = (eligible = true) => ({
  factSheet: { ...investigation().factSheet!, remainingRefundable: eligible ? '42.00' : '0.00', completedRefundTotal: eligible ? '0.00' : '42.00', refundEligible: eligible, refundBlockers: eligible ? [] : ['Nothing left to refund: remaining refundable amount is 0'] },
  eligible,
  reasons: eligible ? [] : ['Nothing left to refund: remaining refundable amount is 0'],
  checkedAt: '2026-11-12T00:01:00Z',
});

function renderWorkspace(d: Deliberation, opts: { eligible?: boolean; inv?: Investigation; onApprove?: (body: unknown) => unknown } = {}) {
  const inv = opts.inv ?? investigation();
  Element.prototype.scrollIntoView = vi.fn();
  const spy = mockFetch({
    [`/api/investigations/${inv.id}/council`]: { body: { items: [d] } },
    [`/api/investigations/${inv.id}/refunds`]: { body: { items: [] } },
    [`/api/investigations/${inv.id}/refund/validate`]: { body: eligibility(opts.eligible ?? true) },
    [`/api/investigations/${inv.id}/refund/approve`]: (_u, init) => ({ body: opts.onApprove?.(JSON.parse(String(init?.body))) ?? { id: 'rf_1', investigationId: inv.id, deliberationId: d.id, captureId: '0NM23031PE726202M', paypalRefundId: '8RS12345AB678901C', amount: '42.00', currency: 'USD', reason: 'x', status: 'completed', idempotencyKey: 'abcdef12-3456', approvedBy: 'merchant', approvedAt: '2026-11-12T00:02:00Z', executedAt: '2026-11-12T00:02:01Z', paypalResponseSummary: 'Verified via get_refund: 8RS12345AB678901C COMPLETED', createdAt: '', reconciling: false } }),
    [`/api/investigations/${inv.id}`]: { body: inv },
  });
  renderWithProviders(<Routes><Route path="/investigations/:id" element={<InvestigationWorkspace />} /></Routes>, { route: `/investigations/${inv.id}` });
  return spy;
}

describe('Decision Council panel', () => {
  it('renders For/Against columns, strikes through invalid citations, and shows the verdict with guardrail result', async () => {
    renderWorkspace(deliberation());
    const forCol = await screen.findByRole('region', { name: 'Advocate: for' });
    const against = screen.getByRole('region', { name: 'Challenger: against' });
    expect(within(forCol).getByText('Refund is fully supported')).toBeInTheDocument();
    expect(within(against).getByText('Invented chargeback exists')).toHaveClass('line-through');
    expect(within(against).getByText('uncited · ignored')).toBeInTheDocument();
    expect(within(against).getByText(/Safer alternative/)).toBeInTheDocument();
    const verdict = screen.getByRole('region', { name: 'Verdict' });
    expect(within(verdict).getByText('APPROVE')).toBeInTheDocument();
    expect(within(verdict).getByText('(estimate)')).toBeInTheDocument();
    expect(within(verdict).getByText(/all checks passed; the Judge's verdict stands/)).toBeInTheDocument();
    expect(within(verdict).getByText('Only if no dispute opens before execution')).toBeInTheDocument();
  });

  it('says plainly when code overrode the Judge, and disables the CTA', async () => {
    renderWorkspace(
      deliberation({
        finalOutcome: 'REJECT',
        executable: null,
        guardrails: { judgeVerdict: 'APPROVE', finalOutcome: 'REJECT', overridden: true, overrideReasons: ['remaining_refundable: Remaining refundable is 0.00 USD: nothing left to refund'], checks: [], executable: null },
      }),
    );
    const verdict = await screen.findByRole('region', { name: 'Verdict' });
    expect(within(verdict).getByText(/code overrode the Judge \(APPROVE → REJECT\)/)).toBeInTheDocument();
    expect(within(verdict).getByText(/nothing left to refund/)).toBeInTheDocument();
    expect(within(verdict).getByRole('button', { name: /Review & approve refund/ })).toBeDisabled();
  });

  it('shows real progressive status while deliberating', async () => {
    renderWorkspace(deliberation({ stage: 'judging', finalOutcome: null, executable: null, judge: null, guardrails: null }));
    const status = await screen.findAllByRole('status');
    const progress = status.find((s) => s.textContent?.includes('Judge deliberating…'))!;
    expect(progress).toHaveTextContent('Advocate done');
    expect(progress).toHaveTextContent('Challenger done');
  });
});

describe('Refund confirmation modal', () => {
  it('requires the checkbox, shows the exact amount on the button, and sends the exact confirmation', async () => {
    let sent: any = null;
    renderWorkspace(deliberation(), { onApprove: (b) => ((sent = b), undefined) });
    const verdict = await screen.findByRole('region', { name: 'Verdict' });
    await userEvent.click(within(verdict).getByRole('button', { name: /Review & approve refund/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Review & approve refund' });
    const confirm = await within(dialog).findByRole('button', { name: 'Refund USD 42.00' });
    await waitFor(() => expect(within(dialog).getByText('Tick the authorization box to continue')).toBeInTheDocument());
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText('0NM23031PE726202M')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText('I authorize this Sandbox refund'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(await within(dialog).findByText('PayPal Sandbox reports COMPLETED')).toBeInTheDocument();
    expect(sent).toMatchObject({ deliberationId: 'del_8b210e0560b3', amount: '42.00', currency: 'USD', confirmationText: 'Refund USD 42.00' });
  });

  it('keeps the button disabled with the reason when live eligibility fails', async () => {
    renderWorkspace(deliberation(), { eligible: false });
    const verdict = await screen.findByRole('region', { name: 'Verdict' });
    await userEvent.click(within(verdict).getByRole('button', { name: /Review & approve refund/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Refund blocked by live checks')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText('I authorize this Sandbox refund'));
    expect(within(dialog).getByRole('button', { name: 'Refund USD 42.00' })).toBeDisabled();
    expect(within(dialog).getByText(/Not eligible: Nothing left to refund/)).toBeInTheDocument();
  });
});
