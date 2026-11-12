import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RefundDetailPage } from './RefundDetail';
import { mockFetch, renderWithProviders } from '../test/utils';

const refund = { id: 'rf_18f82a383c82', investigationId: 'inv_4965eef2dd21', deliberationId: 'del_bed4d07c93e0', captureId: '06W69011L3412890N', paypalRefundId: '5YE09135FX432004L', amount: '20.00', currency: 'USD', reason: 'Partial refund for scratched lens', status: 'completed', idempotencyKey: '3f880c11-5991-4998-930c-220c5cf89f91', approvedBy: 'merchant', approvedAt: '2026-11-12T06:03:08Z', executedAt: '2026-11-12T06:03:09Z', paypalResponseSummary: 'Verified via get_refund', createdAt: '', reconciling: false };

describe('Refund detail page', () => {
  it('shows PayPal live status, the authorising verdict and the audit trail', async () => {
    mockFetch({
      '/api/refunds/rf_18f82a383c82/details': {
        body: {
          refund,
          paypal: { refund: { id: '5YE09135FX432004L', captureId: '06W69011L3412890N', status: 'COMPLETED', amount: { value: '20.00', currency: 'USD' }, createdAt: '2026-11-12T06:03:09Z', updatedAt: null, noteToPayer: 'Partial refund' }, path: 'mcp', checkedAt: new Date().toISOString() },
          paypalError: null,
          deliberation: { id: 'del_bed4d07c93e0', proposal: 'Refund 20.00 USD (partial)', finalOutcome: 'APPROVE', judgeVerdict: 'APPROVE', judgeConfidence: 0.95, rationale: 'Capture completed', strongestDissent: 'Unverified damage', guardrailsOverridden: false, checks: [{ rule: 'remaining_refundable', passed: true, detail: 'Remaining 64.00' }], advocateModel: 'gemini-3.5-flash', challengerModel: 'gemini-3-flash-preview', completedAt: null },
          investigation: { id: 'inv_4965eef2dd21', orderId: '15E54074HC612730M', captureId: '06W69011L3412890N', summary: 'Scratched lens', complaint: 'Lens scratched' },
          audit: [
            { actor: 'merchant', action: 'refund_approved', resourceType: 'refund', request: '{"amount":"20.00"}', result: null, createdAt: '2026-11-12T06:03:08Z' },
            { actor: 'system', action: 'refund_executed', resourceType: 'refund', request: null, result: '{"status":"completed"}', createdAt: '2026-11-12T06:03:10Z' },
          ],
        },
      },
    });
    renderWithProviders(<Routes><Route path="/refunds/:id" element={<RefundDetailPage />} /></Routes>, { route: '/refunds/rf_18f82a383c82' });
    expect(await screen.findByText('Refund USD 20.00')).toBeInTheDocument();
    expect(screen.getAllByText('5YE09135FX432004L').length).toBeGreaterThan(0);
    expect(screen.getByText('guardrails passed')).toBeInTheDocument();
    expect(screen.getByText('(estimate)')).toBeInTheDocument();
    expect(screen.getByText('refund executed')).toBeInTheDocument();
    expect(screen.getByText('3f880c11-5991-4998-930c-220c5cf89f91')).toBeInTheDocument();
  });

  it('flags when PayPal status differs from the app record', async () => {
    mockFetch({ '/api/refunds/rf_18f82a383c82/details': { body: { refund: { ...refund, status: 'pending' }, paypal: { refund: { id: '5YE09135FX432004L', status: 'COMPLETED', amount: { value: '20.00', currency: 'USD' }, createdAt: null, updatedAt: null, noteToPayer: null }, path: 'mcp', checkedAt: '' }, paypalError: null, deliberation: null, investigation: null, audit: [] } } });
    renderWithProviders(<Routes><Route path="/refunds/:id" element={<RefundDetailPage />} /></Routes>, { route: '/refunds/rf_18f82a383c82' });
    expect(await screen.findByText("PayPal's status differs from the app record")).toBeInTheDocument();
  });
});
