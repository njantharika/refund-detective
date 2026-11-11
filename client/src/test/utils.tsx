import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

export function renderWithProviders(ui: ReactNode, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

type Route = (url: URL, init?: RequestInit) => { status?: number; body: unknown } | undefined;

/** Mocks fetch by path prefix. Returns the spy so tests can inspect calls. */
export function mockFetch(routes: Record<string, Route | { status?: number; body: unknown }>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.pathname.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `unmocked ${url.pathname}` } }), { status: 404 });
    const r = routes[key];
    const out = typeof r === 'function' ? r(url, init) : r;
    return new Response(JSON.stringify(out?.body ?? null), { status: out?.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

export const sources = (over: Partial<{ available: boolean; message: string }> = {}) => ({
  transactionSearch: {
    available: over.available ?? true,
    error: over.available === false ? { code: 'PAYPAL_FORBIDDEN', httpStatus: 403, message: over.message ?? 'Authorization failed. Enable Transaction Search for your Sandbox app in the PayPal Developer Dashboard, then regenerate credentials.' } : null,
    count: 0,
    path: 'mcp',
  },
  demoOrders: { tracked: 1, fetched: 1, errors: [] },
});

export const tx = (over: Record<string, unknown> = {}) => ({
  transactionId: '3C679366HH908993F',
  orderId: '5O190127TN364715T',
  captureId: '3C679366HH908993F',
  status: 'COMPLETED',
  eventCode: null,
  amount: { value: '42.00', currency: 'USD' },
  fee: null,
  initiatedAt: '2026-11-10T10:05:00Z',
  updatedAt: null,
  payerCountry: null,
  note: null,
  source: 'demo_order',
  ...over,
});
