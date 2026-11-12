import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database/db.js';
import { PayPalAuth } from '../src/services/paypal/paypal-auth.js';
import type { DiscoveredTool, ToolTransport } from '../src/services/paypal/paypal-mcp-client.js';
import { PayPalToolRegistry } from '../src/services/paypal/paypal-tool-registry.js';
import { PayPalTransactionService } from '../src/services/paypal/paypal-transaction.service.js';
import { PayPalRefundService } from '../src/services/paypal/paypal-refund.service.js';
import { PayPalDisputeService } from '../src/services/paypal/paypal-dispute.service.js';
import type { PayPalIntegration } from '../src/services/paypal/index.js';
import { buildDeps, createApp } from '../src/app.js';
import { StructuredAI, TransportHttpError, type RawTransport } from '../src/ai/provider.js';

/** Scripted AI transport: each entry is returned (or thrown) in order; records every request. */
export class ScriptedTransport implements RawTransport {
  readonly name = 'scripted';
  requests: Parameters<RawTransport['call']>[0][] = [];
  constructor(public script: (string | object | Error | ((req: Parameters<RawTransport['call']>[0]) => string | object))[]) {}
  async call(req: Parameters<RawTransport['call']>[0]) {
    this.requests.push(req);
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0];
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    const v = typeof next === 'function' ? next(req) : next;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
}
export const httpErr = (status: number) => new TransportHttpError(status, `HTTP ${status}`, 0);
export const fakeAI = (script: ConstructorParameters<typeof ScriptedTransport>[0], fallback: string | null = null) => {
  const t = new ScriptedTransport(script);
  return { transport: t, ai: new StructuredAI(t, fallback, { baseBackoffMs: 1 }) };
};

const idSchema = (key: string, pattern = '^[A-Za-z0-9_-]{8,64}$') => ({
  type: 'object',
  additionalProperties: false,
  properties: { [key]: { type: 'string', pattern } },
  required: [key],
});

/** Tool schemas shaped like the ones @paypal/mcp advertises (subset). */
export const FAKE_TOOLS: DiscoveredTool[] = [
  {
    name: 'list_transactions',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        page: { type: 'number', minimum: 1 },
        page_size: { type: 'number', minimum: 1, maximum: 500 },
        transaction_id: { type: ['string', 'null'] },
        transaction_status: { enum: ['D', 'P', 'S', 'V'] },
      },
    },
  },
  { name: 'get_order', inputSchema: idSchema('id', '^[A-Z0-9]{17,32}$') },
  { name: 'get_refund', inputSchema: idSchema('refund_id') },
  { name: 'list_disputes', inputSchema: { type: 'object', properties: { page_size: { type: 'number' }, disputed_transaction_id: { type: ['string', 'null'] } } } },
  {
    name: 'create_refund',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        capture_id: { type: 'string' },
        amount: { type: 'object', properties: { currency_code: { type: 'string' }, value: { type: 'string' } }, required: ['currency_code', 'value'] },
        note_to_payer: { type: 'string' },
      },
      required: ['capture_id'],
    },
  },
  {
    name: 'accept_dispute_claim',
    // Mirrors @paypal/mcp: note is validated with the dispute-ID regex (upstream quirk).
    inputSchema: { type: 'object', additionalProperties: false, properties: { dispute_id: { type: 'string' }, note: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,255}$' } }, required: ['dispute_id', 'note'] },
  },
  { name: 'get_dispute', inputSchema: idSchema('dispute_id', '^[A-Za-z0-9_-]{1,255}$') },
  { name: 'create_order', inputSchema: { type: 'object' } },
  { name: 'pay_order', inputSchema: idSchema('id') },
  { name: 'create_invoice', inputSchema: { type: 'object' } }, // advertised but NOT allowlisted
];

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export class FakeTransport implements ToolTransport {
  ready = true;
  calls: { name: string; args: Record<string, unknown>; timeoutMs: number }[] = [];
  constructor(public handlers: Record<string, Handler> = {}, public tools: DiscoveredTool[] = FAKE_TOOLS) {}
  isReady() {
    return this.ready;
  }
  async listTools() {
    return this.tools;
  }
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number) {
    this.calls.push({ name, args, timeoutMs });
    const h = this.handlers[name];
    if (!h) throw new Error(`no fake handler for ${name}`);
    return h(args);
  }
}

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ PAYPAL_ENVIRONMENT: 'SANDBOX', PAYPAL_ACCESS_TOKEN: 'test-token', DATABASE_PATH: ':memory:', ...overrides });
}

export function makeHarness(handlers: Record<string, Handler> = {}, opts: { ai?: StructuredAI } = {}) {
  const cfg = testConfig();
  const db = openDatabase(':memory:');
  const transport = new FakeTransport(handlers);
  const registry = new PayPalToolRegistry(transport, null);
  const paypal: PayPalIntegration = {
    auth: new PayPalAuth(cfg),
    mcp: null,
    registry,
    transactions: new PayPalTransactionService(registry),
    refunds: new PayPalRefundService(registry),
    disputes: new PayPalDisputeService(registry),
    start: async () => {},
    shutdown: async () => {},
  };
  const deps = buildDeps(cfg, db, paypal, opts.ai ?? new StructuredAI(null, null));
  return { cfg, db, transport, registry, paypal, deps, app: createApp(deps) };
}

/** A captured Orders v2 response with one capture and the given refunds. */
export function orderFixture(opts: { id?: string; captureId?: string; amount?: string; currency?: string; refunds?: { id: string; value: string; status?: string; createdAt?: string }[] } = {}) {
  const id = opts.id ?? '5O190127TN364715T';
  const captureId = opts.captureId ?? '3C679366HH908993F';
  const currency = opts.currency ?? 'USD';
  return {
    id,
    status: 'COMPLETED',
    intent: 'CAPTURE',
    create_time: '2026-11-10T10:00:00Z',
    update_time: '2026-11-10T10:05:00Z',
    purchase_units: [
      {
        amount: { currency_code: currency, value: opts.amount ?? '42.00' },
        description: 'Test order',
        payments: {
          captures: [{ id: captureId, status: (opts.refunds?.length ?? 0) > 0 ? 'PARTIALLY_REFUNDED' : 'COMPLETED', amount: { currency_code: currency, value: opts.amount ?? '42.00' }, final_capture: true, create_time: '2026-11-10T10:05:00Z' }],
          refunds: (opts.refunds ?? []).map((r) => ({
            id: r.id,
            status: r.status ?? 'COMPLETED',
            amount: { currency_code: currency, value: r.value },
            create_time: r.createdAt ?? '2026-11-10T12:00:00Z',
            links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }],
          })),
        },
      },
    ],
    links: [],
  };
}
