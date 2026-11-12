import type { Investigation } from '../lib/api';

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

