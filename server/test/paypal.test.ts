import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { parseToolResult } from '../src/services/paypal/paypal-mcp-client.js';
import { PayPalToolRegistry } from '../src/services/paypal/paypal-tool-registry.js';
import { PayPalRestFallback } from '../src/services/paypal/paypal-rest-fallback.js';
import { PayPalAuth } from '../src/services/paypal/paypal-auth.js';
import { chunkDateRange, normalizeOrder, normalizeSearchTransaction, orderToTransactions } from '../src/services/paypal/paypal-transaction.service.js';
import { PayPalError } from '../src/services/paypal/paypal.types.js';
import { FakeTransport, makeHarness, orderFixture, testConfig } from './helpers.js';

describe('MCP tool discovery and allowlist', () => {
  it('lists discovered tools and marks non-allowlisted ones', async () => {
    const reg = new PayPalToolRegistry(new FakeTransport(), null);
    await reg.refreshSchemas();
    const tools = reg.discoveredTools();
    expect(tools.find((t) => t.name === 'create_invoice')?.allowed).toBe(false);
    expect(tools.find((t) => t.name === 'get_order')?.allowed).toBe(true);
    expect(reg.missingAllowedTools()).toEqual([]);
  });

  it('rejects tools that are not on the allowlist, even if the server advertises them', async () => {
    const t = new FakeTransport({ create_invoice: () => ({}) });
    const reg = new PayPalToolRegistry(t, null);
    // @ts-expect-error deliberately calling a non-allowlisted tool
    await expect(reg.read('create_invoice', {})).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    expect(t.calls).toHaveLength(0);
  });

  it('validates arguments against the discovered inputSchema before calling', async () => {
    const t = new FakeTransport({ get_order: () => ({}) });
    const reg = new PayPalToolRegistry(t, null);
    await expect(reg.read('get_order', { id: 'not valid!' })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGS' });
    await expect(reg.read('get_order', { id: '5O190127TN364715T', extra: 1 })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGS' });
    expect(t.calls).toHaveLength(0);
  });

  it('refuses write tools without explicit approval', async () => {
    const t = new FakeTransport({ create_refund: () => ({ id: 'R1', status: 'COMPLETED' }) });
    const reg = new PayPalToolRegistry(t, null);
    // @ts-expect-error approval flag missing on purpose
    await expect(reg.write('create_refund', { capture_id: '3C679366HH908993F' }, {})).rejects.toMatchObject({ code: 'WRITE_NOT_APPROVED' });
    expect(t.calls).toHaveLength(0);
  });

  it('applies 15s timeouts to reads and 30s to writes', async () => {
    const t = new FakeTransport({ get_order: () => ({ id: 'X' }), create_refund: () => ({ id: 'R1' }) });
    const reg = new PayPalToolRegistry(t, null);
    await reg.read('get_order', { id: '5O190127TN364715T' });
    await reg.write('create_refund', { capture_id: '3C679366HH908993F' }, { approved: true });
    expect(t.calls.map((c) => c.timeoutMs)).toEqual([15_000, 30_000]);
  });
});

describe('MCP error and timeout handling', () => {
  it('converts {ok:false,status:403} content into a PayPalError', () => {
    const r = { content: [{ type: 'text', text: '{"ok":false,"status":403,"code":"PAYPAL_API_HTTP_ERROR","message":"Authorization failed due to insufficient permissions."}' }] };
    try {
      parseToolResult('list_transactions', r);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PayPalError);
      expect((e as PayPalError).httpStatus).toBe(403);
      expect((e as PayPalError).code).toBe('PAYPAL_FORBIDDEN');
    }
  });

  it('converts isError results into a PayPalError', () => {
    expect(() => parseToolResult('get_order', { isError: true, content: [{ type: 'text', text: 'boom' }] })).toThrow(PayPalError);
  });

  it('parses JSON text content on success', () => {
    expect(parseToolResult('get_order', { content: [{ type: 'text', text: '{"id":"A"}' }] })).toEqual({ id: 'A' });
  });

  it('records failed calls (tool, status, duration) and rethrows timeouts', async () => {
    const t = new FakeTransport({
      get_order: () => {
        throw new PayPalError('MCP tool get_order timed out after 15000ms', null, 'TIMEOUT', 'get_order');
      },
    });
    const reg = new PayPalToolRegistry(t, null);
    await expect(reg.read('get_order', { id: '5O190127TN364715T' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(reg.lastCall()).toMatchObject({ tool: 'get_order', ok: false, errorCode: 'TIMEOUT', path: 'mcp' });
  });

  it('uses the REST fallback only when MCP is unavailable, and reports the path', async () => {
    const t = new FakeTransport();
    t.ready = false;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: '5O190127TN364715T', status: 'COMPLETED' }), { status: 200 }));
    const auth = new PayPalAuth(testConfig());
    const reg = new PayPalToolRegistry(t, new PayPalRestFallback(auth, fetchMock as unknown as typeof fetch));
    const out = await reg.read('get_order', { id: '5O190127TN364715T' });
    expect(out.path).toBe('rest_fallback');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(reg.pathUsage()).toEqual({ mcp: 0, rest_fallback: 1 });
  });

  it('sends the app idempotency key as PayPal-Request-Id on the REST refund path', async () => {
    const t = new FakeTransport();
    t.ready = false;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'R1', status: 'COMPLETED' }), { status: 201 }));
    const reg = new PayPalToolRegistry(t, new PayPalRestFallback(new PayPalAuth(testConfig()), fetchMock as unknown as typeof fetch));
    await reg.write('create_refund', { capture_id: '3C679366HH908993F', amount: { currency_code: 'USD', value: '1.00' } }, { approved: true, idempotencyKey: 'idem-123' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['PayPal-Request-Id']).toBe('idem-123');
    expect(JSON.parse(String(init.body))).not.toHaveProperty('__idempotency_key');
  });
});

describe('PayPal OAuth client credentials', () => {
  it('mints, caches, and emits tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'minted', expires_in: 32400 }), { status: 200 }));
    const auth = new PayPalAuth(testConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ACCESS_TOKEN: '' }), fetchMock as unknown as typeof fetch);
    const onToken = vi.fn();
    auth.on('token', onToken);
    expect(auth.mode).toBe('client_credentials');
    expect(await auth.getToken()).toBe('minted');
    expect(await auth.getToken()).toBe('minted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith('minted');
    expect(auth.status().warning).toBeNull();
    auth.stop();
  });
});

describe('transaction normalization', () => {
  it('normalizes a Transaction Search row; missing fields become null', () => {
    const t = normalizeSearchTransaction({ transaction_info: { transaction_id: '3C679366HH908993F', transaction_status: 'S', transaction_amount: { currency_code: 'USD', value: '42.00' } } });
    expect(t).toMatchObject({ transactionId: '3C679366HH908993F', captureId: '3C679366HH908993F', status: 'COMPLETED', amount: { value: '42.00', currency: 'USD' }, fee: null, initiatedAt: null, orderId: null });
  });

  it('resolves captures and links refunds to their capture', () => {
    const o = normalizeOrder(orderFixture({ refunds: [{ id: 'R1', value: '10.00' }] }));
    expect(o.captures).toHaveLength(1);
    expect(o.captures[0].id).toBe('3C679366HH908993F');
    expect(o.captures[0].refunds.map((r) => r.id)).toEqual(['R1']);
    expect(o.amount).toEqual({ value: '42.00', currency: 'USD' });
  });

  it('projects an uncaptured order onto a single row without a capture id', () => {
    const rows = orderToTransactions(normalizeOrder({ id: 'ABCDEFGHIJKLMNOPQ', status: 'CREATED', purchase_units: [{ amount: { currency_code: 'USD', value: '5.00' } }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ captureId: null, status: 'CREATED', orderId: 'ABCDEFGHIJKLMNOPQ' });
  });

  it('chunks long ranges into ≤31-day windows', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-04-01T00:00:00Z');
    const w = chunkDateRange(from, to);
    expect(w.length).toBe(3);
    for (const x of w) expect(x.end.getTime() - x.start.getTime()).toBeLessThanOrEqual(31 * 86_400_000);
    expect(w[w.length - 1].start.getTime()).toBe(from.getTime());
    expect(w[0].end.getTime()).toBe(to.getTime());
  });
});

describe('GET /api/transactions', () => {
  it('reports a Transaction Search 403 with the dashboard hint and still merges demo orders', async () => {
    const h = makeHarness({
      list_transactions: () => {
        throw new PayPalError('Authorization failed due to insufficient permissions.', 403, 'PAYPAL_FORBIDDEN', 'list_transactions');
      },
      get_order: () => orderFixture(),
    });
    h.db.prepare("INSERT INTO demo_orders (order_id) VALUES ('5O190127TN364715T')").run();
    const res = await request(h.app).get('/api/transactions');
    expect(res.status).toBe(200);
    expect(res.body.sources.transactionSearch.available).toBe(false);
    expect(res.body.sources.transactionSearch.error.message).toMatch(/Enable Transaction Search/);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ captureId: '3C679366HH908993F', orderId: '5O190127TN364715T', source: 'demo_order' });
  });

  it('filters by status, currency and id search', async () => {
    const h = makeHarness({
      list_transactions: () => ({
        transaction_details: [
          { transaction_info: { transaction_id: 'AAAAAAAAAAAAAAAA1', transaction_status: 'S', transaction_amount: { currency_code: 'USD', value: '1.00' }, transaction_initiation_date: '2026-11-01T00:00:00Z' } },
          { transaction_info: { transaction_id: 'BBBBBBBBBBBBBBBB2', transaction_status: 'P', transaction_amount: { currency_code: 'EUR', value: '2.00' }, transaction_initiation_date: '2026-11-02T00:00:00Z' } },
        ],
        total_pages: 1,
      }),
    });
    const all = await request(h.app).get('/api/transactions');
    expect(all.body.total).toBe(2);
    expect(all.body.facets.currencies).toEqual(['EUR', 'USD']);
    expect((await request(h.app).get('/api/transactions?status=PENDING')).body.items.map((t: any) => t.transactionId)).toEqual(['BBBBBBBBBBBBBBBB2']);
    expect((await request(h.app).get('/api/transactions?currency=USD')).body.total).toBe(1);
    expect((await request(h.app).get('/api/transactions?q=aaaa')).body.total).toBe(1);
  });

  it('rejects invalid query params with a 400', async () => {
    const h = makeHarness();
    const res = await request(h.app).get('/api/transactions?currency=dollars');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/dashboard/summary', () => {
  it('computes KPIs from real (mocked) PayPal data', async () => {
    const h = makeHarness({
      list_transactions: () => ({ transaction_details: [], total_pages: 1 }),
      get_order: () => orderFixture({ refunds: [{ id: 'R1', value: '10.00' }] }),
      list_disputes: () => ({ items: [] }),
    });
    h.db.prepare("INSERT INTO demo_orders (order_id) VALUES ('5O190127TN364715T')").run();
    const res = await request(h.app).get('/api/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.dataMode).toBe('live');
    expect(res.body.kpis).toMatchObject({ total: 1, successful: 1, openDisputes: 0, refunds: { count: 1, amount: { USD: 10 } } });
  });
});
