import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverviewPage } from './Overview';
import { TransactionsPage } from './Transactions';
import { SettingsPage } from './Settings';
import { mockFetch, renderWithProviders, sources, tx } from '../test/utils';

const summary = {
  range: { from: '2026-10-12T00:00:00Z', to: '2026-11-11T00:00:00Z' },
  dataMode: 'live',
  kpis: {
    total: 3, successful: 2, failed: 0, pending: 1,
    capturedVolume: { USD: 131 },
    refunds: { count: 1, amount: { USD: 10 } },
    activity: [{ date: '2026-11-10', count: 3, volume: 131 }],
    refundTrend: [{ date: '2026-11-10', count: 1 }],
    openInvestigations: 2, openDisputes: 0,
  },
  investigationPipeline: { open: 2, awaiting_approval: 0, resolved: 1, closed: 0 },
  recentActivity: [],
  sources: { ...sources(), disputesError: null },
  fetchedAt: new Date().toISOString(),
};

const status = {
  appVersion: '0.1.0',
  paypal: {
    environment: 'SANDBOX', apiBase: 'https://api-m.sandbox.paypal.com',
    auth: { mode: 'static_token', hasToken: true, expiresAt: null, warning: 'token expires; add client credentials', lastError: null },
    mcp: { state: 'ready', serverName: 'PayPal', serverVersion: '1.11.0', toolCount: 28, restarts: 0, lastError: null, command: 'node @paypal/mcp' },
    tools: [{ name: 'get_order', allowed: true }, { name: 'create_invoice', allowed: false }],
    missingAllowedTools: [], lastCall: null, pathUsage: { mcp: 0, rest_fallback: 0 }, restFallback: { available: true, active: false },
  },
  ai: { provider: 'anthropic', configured: false, message: 'AI not configured', models: { investigator: 'claude-sonnet-5-5', advocate: 'claude-sonnet-5-5', challenger: 'claude-sonnet-5-5', judge: 'claude-opus-5-5' }, councilRebuttal: false },
  database: { path: './data/x.db', sizeBytes: 4096 },
  webhooks: { configured: false, received: 0 },
};

describe('Overview (dashboard render)', () => {
  it('renders KPIs from the API', async () => {
    mockFetch({ '/api/dashboard/summary': { body: summary }, '/api/settings/integration-status': { body: status } });
    renderWithProviders(<OverviewPage />);
    expect(await screen.findByText('Total payments')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('$131.00 captured')).toBeInTheDocument());
    expect(screen.getByText('Open investigations').parentElement?.parentElement).toHaveTextContent('2');
    expect(screen.getByText('AI not configured')).toBeInTheDocument();
  });

  it('shows the Transaction Search 403 notice instead of hiding it', async () => {
    mockFetch({ '/api/dashboard/summary': { body: { ...summary, sources: { ...sources({ available: false }), disputesError: null } } }, '/api/settings/integration-status': { body: status } });
    renderWithProviders(<OverviewPage />);
    expect(await screen.findByText(/Transaction Search is not enabled/)).toBeInTheDocument();
    expect(screen.getByText(/Enable Transaction Search for your Sandbox app/)).toBeInTheDocument();
  });

  it('shows an error state when the API fails', async () => {
    mockFetch({ '/api/dashboard/summary': { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } }, '/api/settings/integration-status': { body: status } });
    renderWithProviders(<OverviewPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the dashboard');
  });
});

describe('Transactions', () => {
  const list = (items: unknown[]) => ({ items, page: 1, pageSize: 25, total: items.length, facets: { statuses: ['COMPLETED', 'PENDING'], currencies: ['USD'] }, sources: sources(), fetchedAt: new Date().toISOString() });

  it('sends status and currency filters to the API', async () => {
    const spy = mockFetch({ '/api/transactions': { body: list([tx()]) } });
    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    expect(await screen.findByText('$42.00')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'PENDING');
    await userEvent.selectOptions(screen.getByLabelText('Filter by currency'), 'USD');
    await waitFor(() => {
      const last = new URL(String(spy.mock.calls.at(-1)![0]), 'http://x');
      expect(last.searchParams.get('status')).toBe('PENDING');
      expect(last.searchParams.get('currency')).toBe('USD');
    });
  });

  it('shows an empty state when nothing matches', async () => {
    mockFetch({ '/api/transactions': { body: list([]) } });
    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    expect(await screen.findByText('No PayPal transactions in this range')).toBeInTheDocument();
  });

  it('opens the detail drawer with captures, refunds and the Investigate button', async () => {
    mockFetch({
      '/api/transactions/3C679366HH908993F/details': {
        body: {
          id: '3C679366HH908993F',
          order: { id: '5O190127TN364715T', status: 'COMPLETED', intent: 'CAPTURE', createdAt: null, updatedAt: null, amount: { value: '42.00', currency: 'USD' }, description: 'Notebook', captures: [], refunds: [], approveUrl: null },
          transaction: null,
          captures: [{ id: '3C679366HH908993F', status: 'PARTIALLY_REFUNDED', amount: { value: '42.00', currency: 'USD' }, finalCapture: true, createdAt: null, updatedAt: null, refunds: [] }],
          refunds: [{ id: '1JU08902781691411', status: 'COMPLETED', amount: { value: '10.00', currency: 'USD' }, createdAt: null, updatedAt: null, noteToPayer: null }],
          disputes: [], events: [], investigations: [], errors: [],
        },
      },
      '/api/transactions': { body: list([tx()]) },
    });
    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await userEvent.click(await screen.findByLabelText('Open transaction 3C679366HH908993F'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Captures (1)')).toBeInTheDocument();
    expect(within(dialog).getByText('1JU08902781691411')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Investigate with AI/ })).toBeInTheDocument();
    expect(within(dialog).getByText('No disputes on these captures.')).toBeInTheDocument();
  });
});

describe('Settings', () => {
  it('shows MCP status and never a secret', async () => {
    mockFetch({ '/api/settings/integration-status': { body: status } });
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText('PayPal 1.11.0')).toBeInTheDocument();
    expect(screen.getByText('Present (hidden)')).toBeInTheDocument();
    expect(screen.getByText(/token expires; add client credentials/)).toBeInTheDocument();
  });
});
