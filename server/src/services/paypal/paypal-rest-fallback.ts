import type { PayPalAuth } from './paypal-auth.js';
import { PayPalError } from './paypal.types.js';
import { scrubSecrets } from '../../lib/logger.js';

type Args = Record<string, unknown>;

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

/**
 * Server-side REST equivalents of the allowlisted MCP tools, mirroring the endpoints @paypal/mcp
 * calls. Used ONLY when the MCP server is unavailable. Sandbox base URL is hard-coded.
 */
export class PayPalRestFallback {
  constructor(
    private readonly auth: PayPalAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supports(tool: string): boolean {
    return tool in this.routes;
  }

  private readonly routes: Record<string, (a: Args) => { method: 'GET' | 'POST'; path: string; body?: unknown; requestId?: string }> = {
    list_transactions: (a) => {
      const q = new URLSearchParams({ fields: 'all' });
      for (const k of ['start_date', 'end_date', 'transaction_status', 'transaction_id', 'page', 'page_size'] as const) {
        if (a[k] !== undefined && a[k] !== null) q.set(k, String(a[k]));
      }
      return { method: 'GET', path: `/v1/reporting/transactions?${q}` };
    },
    get_order: (a) => ({ method: 'GET', path: `/v2/checkout/orders/${enc(a.id)}` }),
    get_refund: (a) => ({ method: 'GET', path: `/v2/payments/refunds/${enc(a.refund_id)}` }),
    list_disputes: (a) => {
      const q = new URLSearchParams();
      for (const k of ['dispute_state', 'disputed_transaction_id', 'page_size'] as const) {
        if (a[k] !== undefined && a[k] !== null) q.set(k, String(a[k]));
      }
      return { method: 'GET', path: `/v1/customer/disputes?${q}` };
    },
    get_dispute: (a) => ({ method: 'GET', path: `/v1/customer/disputes/${enc(a.dispute_id)}` }),
    create_refund: (a) => ({
      method: 'POST',
      path: `/v2/payments/captures/${enc(a.capture_id)}/refund`,
      body: { amount: a.amount, note_to_payer: a.note_to_payer, invoice_id: a.invoice_id },
      requestId: typeof a.__idempotency_key === 'string' ? a.__idempotency_key : undefined,
    }),
    accept_dispute_claim: (a) => ({ method: 'POST', path: `/v1/customer/disputes/${enc(a.dispute_id)}/accept-claim`, body: { note: a.note } }),
  };

  async call(tool: string, args: Args, timeoutMs: number): Promise<unknown> {
    const route = this.routes[tool];
    if (!route) throw new PayPalError(`REST fallback does not support ${tool}`, null, 'FALLBACK_UNSUPPORTED', tool);
    const { method, path, body, requestId } = route(args);
    const token = await this.auth.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    let res: Response;
    try {
      res = await this.fetchImpl(`${SANDBOX_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = /abort|timeout/i.test(msg);
      throw new PayPalError(timedOut ? `REST ${tool} timed out` : `REST ${tool} failed: ${scrubSecrets(msg)}`, null, timedOut ? 'TIMEOUT' : 'REST_FAILED', tool);
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const p = parsed as { message?: string; name?: string } | null;
      throw new PayPalError(scrubSecrets(p?.message ?? `HTTP ${res.status}`), res.status, res.status === 403 ? 'PAYPAL_FORBIDDEN' : 'PAYPAL_API_ERROR', tool);
    }
    return parsed;
  }
}

function enc(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new PayPalError('Invalid resource id', 400, 'INVALID_ID');
  return encodeURIComponent(v);
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
