import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { InvestigationWorkspace } from './InvestigationWorkspace';
import { reportMarkdown } from '../lib/report-md';
import type { Investigation } from '../lib/api';
import { mockFetch, renderWithProviders } from '../test/utils';

const fs = {
  targetCaptureId: '0NM23031PE726202M', orderId: '2N3925934C459540S', orderStatus: 'COMPLETED', captureStatus: 'COMPLETED', captureCount: 1, currency: 'USD',
  capturedAmount: '42.00', completedRefundTotal: '0.00', pendingRefundTotal: '0.00', remainingRefundable: '42.00', refunds: [], openDisputes: [], hasOpenDispute: false,
  appPendingRefund: false, appRefundsUnknown: false, lockHeld: false, currencyMismatch: false, conflictingStatuses: [],
  missingEvidence: ['No PayPal webhook events received (Event Monitor not configured)'], refundBlockers: [], refundEligible: true, computedAt: '2026-11-12T00:00:00Z',
};
const evidence = [
  { id: 'EV-001', type: 'order', source: 'paypal_mcp', description: 'Order 2N3925934C459540S status COMPLETED', observedAt: '2026-11-11T18:00:00Z', normalized: {}, verified: true, provenance: { tool: 'get_order', path: 'mcp', fetchedAt: '' } },
  { id: 'EV-002', type: 'capture', source: 'paypal_mcp', description: 'Capture 0NM23031PE726202M status COMPLETED, amount 42.00 USD', observedAt: '2026-11-11T18:01:00Z', normalized: {}, verified: true, provenance: { tool: 'get_order', path: 'mcp', fetchedAt: '' } },
  { id: 'EV-003', type: 'merchant_complaint', source: 'merchant_input', description: 'Customer complaint', observedAt: '2026-11-12T00:00:00Z', normalized: { complaint: 'No confirmation email' }, verified: false, provenance: { tool: null, path: 'merchant', fetchedAt: '' } },
] as Investigation['evidence'];

export const investigation = (over: Partial<Investigation> = {}): Investigation => ({
  id: 'inv_7833cb461c58', transactionId: '2N3925934C459540S', orderId: '2N3925934C459540S', captureId: '0NM23031PE726202M', complaint: 'No confirmation email', status: 'open',
  stage: 'ready', stageDetail: null, error: null, running: false, createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z', factSheet: fs, evidence,
  report: {
    caseSummary: 'Payment captured; customer did not get a confirmation.', customerComplaint: 'No confirmation email', transactionStatus: 'COMPLETED',
    findings: [
      { title: 'Successful Payment Capture', explanation: 'Captured 42.00 USD', evidenceIds: ['EV-001', 'EV-002'], kind: 'observed', severity: 'low' },
      { title: 'Customer Missing Email Claim', explanation: 'Customer says no email', evidenceIds: ['EV-003'], kind: 'observed', severity: 'medium' },
    ],
    likelyRootCause: { description: 'Confirmation email not delivered', confidence: 0.8, supportingEvidenceIds: ['EV-002'], limitations: ['No email logs'] },
    alternativeExplanations: [{ description: 'Spam folder', evidenceIds: ['EV-003'] }],
    missingInformation: ['Merchant email logs'],
    proposedDecision: { type: 'refund', amount: '42.00', currency: 'USD', reason: 'Customer asked' },
  },
  citationAudit: { removedFindings: [{ title: 'Invented chargeback', invalidIds: ['EV-999'], reason: 'invalid_citation' }], droppedIds: [] },
  toolCalls: [], model: 'gemini-3.5-flash', generatedAt: '2026-11-12T00:00:30Z', messages: [],
  ...over,
});

const renderAt = (inv: Investigation) => {
  mockFetch({ [`/api/investigations/${inv.id}`]: { body: inv } });
  return renderWithProviders(<Routes><Route path="/investigations/:id" element={<InvestigationWorkspace />} /></Routes>, { route: `/investigations/${inv.id}` });
};

describe('Investigation workspace', () => {
  it('renders cited findings, FactSheet, root cause estimate and the removed-claim notice', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderAt(investigation());
    expect(await screen.findByText('Successful Payment Capture')).toBeInTheDocument();
    expect(screen.getAllByText('42.00 USD').length).toBeGreaterThan(0);
    expect(screen.getByText('estimate')).toBeInTheDocument();
    expect(screen.getByText('1 uncited claim(s) removed by code')).toBeInTheDocument();
    expect(screen.getByText('Invented chargeback')).toHaveClass('line-through');
    // A finding backed only by unverified merchant input is labelled as an allegation.
    const claim = screen.getByText('Customer Missing Email Claim').closest('li')!;
    expect(within(claim).getByText('allegation only')).toBeInTheDocument();
    // Missing evidence appears as a timeline marker.
    expect(screen.getByText(/Event Monitor not configured/)).toBeInTheDocument();
  });

  it('clicking an evidence chip scrolls to and highlights that evidence', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderAt(investigation());
    const finding = (await screen.findByText('Successful Payment Capture')).closest('li')!;
    await userEvent.click(within(finding).getByRole('button', { name: 'Show evidence EV-002' }));
    expect(scroll).toHaveBeenCalled();
    expect(document.getElementById('ev-EV-002')).toHaveClass('ring-1');
  });

  it('keeps the refund CTA disabled (council not built yet) and labels the proposal as a recommendation', async () => {
    renderAt(investigation());
    expect(await screen.findByRole('button', { name: /Review & approve refund/ })).toBeDisabled();
    expect(screen.getByText(/recommendation only/)).toBeInTheDocument();
  });

  it('shows the live pipeline stage while running', async () => {
    renderAt(investigation({ stage: 'analyzing', stageDetail: 'Waiting 7s for the AI rate limit…', report: null, running: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting 7s for the AI rate limit…');
  });

  it('shows a failure state with the real error', async () => {
    renderAt(investigation({ stage: 'failed', error: 'AI_INVALID_OUTPUT: bad JSON', report: null }));
    expect(await screen.findByText('Investigation failed')).toBeInTheDocument();
    expect(screen.getByText(/AI_INVALID_OUTPUT/)).toBeInTheDocument();
  });

  it('says AI not configured instead of showing a fake report', async () => {
    renderAt(investigation({ stage: 'ai_unavailable', report: null, model: null }));
    expect(await screen.findAllByText('AI not configured')).not.toHaveLength(0);
    expect(screen.queryByText('Successful Payment Capture')).not.toBeInTheDocument();
  });
});

describe('Markdown export', () => {
  it('includes FactSheet, cited findings, the estimate label and the Sandbox environment', () => {
    const md = reportMarkdown(investigation());
    expect(md).toContain('PayPal **Sandbox**');
    expect(md).toContain('| Remaining refundable | 42.00 |');
    expect(md).toContain('**Successful Payment Capture** (observed, low) [EV-001, EV-002]');
    expect(md).toContain('Confidence (estimate, not a statistical guarantee): 80%');
    expect(md).toContain('recommendation only; not executed');
  });
});
