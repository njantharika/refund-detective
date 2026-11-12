import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { DisputesPage } from './Disputes';
import { InsightsPage } from './Insights';
import { RefundsPage } from './Refunds';
import { DemoBanner } from '../components/Shell';
import { mockFetch, renderWithProviders, sources } from '../test/utils';

describe('Disputes', () => {
  it('shows an honest empty state and the no-evidence-submission note', async () => {
    mockFetch({ '/api/disputes': { body: { items: [], path: 'mcp' } } });
    renderWithProviders(<DisputesPage />);
    expect(await screen.findByText('No disputes in this Sandbox account')).toBeInTheDocument();
    expect(screen.getByText(/cannot submit evidence/)).toBeInTheDocument();
  });
  it('lists disputes from PayPal', async () => {
    mockFetch({ '/api/disputes': { body: { items: [{ id: 'PP-D-1', status: 'OPEN', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'INQUIRY', amount: { value: '42.00', currency: 'USD' }, createdAt: null, updatedAt: null, disputedTransactionIds: ['CAP'], outcome: null }], path: 'mcp' } } });
    renderWithProviders(<DisputesPage />);
    expect(await screen.findByText('PP-D-1')).toBeInTheDocument();
    expect(screen.getByText('$42.00')).toBeInTheDocument();
  });
});

describe('Insights', () => {
  it('renders metrics and a cited AI summary', async () => {
    mockFetch({
      '/api/insights': {
        body: {
          range: { from: '', to: '' },
          metrics: { payments: { total: 3, successful: 3, failed: 0, pending: 0 }, capturedVolume: { USD: 131 }, refunds: { count: 1, amount: { USD: 20 }, ratePercentOfCaptured: { USD: 15.3 } }, statusDistribution: { COMPLETED: 2, PARTIALLY_REFUNDED: 1 }, disputes: { total: 0, open: 0 }, council: { verdicts: { APPROVE: 2, REJECT: 1 }, guardrailOverrides: 0 }, investigations: { reportsReady: 2, avgRootCauseConfidence: 0.8, uncitedClaimsRemoved: 0 } },
          series: { activity: [], refundTrend: [] },
          sources: { ...sources(), disputesError: null },
          latestSummary: { headline: 'Low refund rate on a small sample', observations: [{ text: 'One refund so far', metrics: ['refunds.count'] }], caveats: [], removedUncited: 0, model: 'gemini-3.5-flash', createdAt: new Date().toISOString() },
          fetchedAt: '',
        },
      },
    });
    renderWithProviders(<InsightsPage />);
    expect(await screen.findByText('Low refund rate on a small sample')).toBeInTheDocument();
    expect(screen.getByText('refunds.count')).toBeInTheDocument();
    expect(screen.getByText('$131.00')).toBeInTheDocument();
    expect(screen.getByText(/1 refund\(s\) · 15.3% of USD/)).toBeInTheDocument();
  });
});

describe('Refunds', () => {
  it('lists executed refunds with PayPal status', async () => {
    mockFetch({ '/api/refunds': { body: { items: [{ id: 'rf_1', investigationId: 'inv_4965eef2dd21', deliberationId: 'del_1', captureId: '06W69011L3412890N', paypalRefundId: '5YE09135FX432004L', amount: '20.00', currency: 'USD', reason: '', status: 'completed', idempotencyKey: 'k', approvedBy: 'merchant', approvedAt: '2026-11-12T06:03:08Z', executedAt: null, paypalResponseSummary: 'Verified via get_refund', createdAt: '', reconciling: false }] } } });
    renderWithProviders(<RefundsPage />);
    expect(await screen.findByText('5YE09135FX432004L')).toBeInTheDocument();
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
  });
});

describe('Demo mode banner', () => {
  it('appears when no PayPal credentials are configured', async () => {
    mockFetch({ '/api/settings/integration-status': { body: { demoMode: { active: true, message: 'Demo mode: set credentials.' } } } });
    renderWithProviders(<DemoBanner />);
    expect(await screen.findByText('DEMO MODE')).toBeInTheDocument();
    expect(screen.getByText(/sample data, not PayPal data/)).toBeInTheDocument();
  });
});
