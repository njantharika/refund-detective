import type { DB } from '../database/db.js';
import type { PayPalIntegration } from './paypal/index.js';
import { orderToTransactions, type SearchOutcome } from './paypal/paypal-transaction.service.js';
import { PayPalError, type NormalizedOrder, type NormalizedTransaction } from './paypal/paypal.types.js';
import { DEMO_TRANSACTIONS, DEMO_MODE_MESSAGE } from './demo.js';

export interface ExplorerSources {
  transactionSearch: { available: boolean; error: SearchOutcome['searchError']; count: number; path: string | null };
  demoOrders: { tracked: number; fetched: number; errors: { orderId: string; message: string }[] };
  /** True only when no PayPal credentials exist; rows are labelled sample data, never PayPal data. */
  demoMode?: { active: true; message: string };
}

export interface ExplorerSnapshot {
  transactions: NormalizedTransaction[];
  orders: NormalizedOrder[];
  sources: ExplorerSources;
  fetchedAt: string;
}

const CACHE_MS = 20_000;

/**
 * Merges Transaction Search results with orders this app created (fetched live via get_order),
 * which covers Sandbox indexing lag and a missing Transaction Search permission.
 */
export class ExplorerService {
  private cache: { key: string; at: number; snap: ExplorerSnapshot } | null = null;

  constructor(
    private readonly db: DB,
    private readonly paypal: PayPalIntegration,
  ) {}

  invalidate() {
    this.cache = null;
  }

  async snapshot(range: { from: Date; to: Date }, force = false): Promise<ExplorerSnapshot> {
    const key = `${range.from.toISOString()}|${range.to.toISOString()}`;
    if (!force && this.cache && this.cache.key === key && Date.now() - this.cache.at < CACHE_MS) return this.cache.snap;

    if (this.paypal.auth.mode === 'none') {
      return {
        transactions: DEMO_TRANSACTIONS.filter((t) => !t.initiatedAt || (t.initiatedAt >= range.from.toISOString() && t.initiatedAt <= range.to.toISOString())),
        orders: [],
        sources: { transactionSearch: { available: false, error: null, count: 0, path: null }, demoOrders: { tracked: 0, fetched: 0, errors: [] }, demoMode: { active: true, message: DEMO_MODE_MESSAGE } },
        fetchedAt: new Date().toISOString(),
      };
    }
    const demoIds = this.db.prepare('SELECT order_id FROM demo_orders ORDER BY created_at DESC').pluck().all() as string[];
    const [search, demo] = await Promise.all([
      this.paypal.transactions.search(range),
      Promise.all(
        demoIds.map(async (id) => {
          try {
            return { id, order: (await this.paypal.transactions.getOrder(id)).order };
          } catch (e) {
            return { id, error: e instanceof PayPalError ? e.message : String(e) };
          }
        }),
      ),
    ]);

    const orders = demo.filter((d): d is { id: string; order: NormalizedOrder } => 'order' in d && !!d.order);
    const byCapture = new Map<string, NormalizedTransaction>();
    const rows: NormalizedTransaction[] = [];
    for (const t of search.transactions) {
      if (t.captureId) byCapture.set(t.captureId, t);
      rows.push(t);
    }
    for (const { order } of orders) {
      for (const t of orderToTransactions(order)) {
        const existing = t.captureId ? byCapture.get(t.captureId) : undefined;
        if (existing) {
          existing.orderId = order.id; // enrich the search row with the order id we know
          if (t.status) existing.status = t.status; // live capture status is fresher than the index
        } else rows.push(t);
      }
    }
    rows.sort((a, b) => (b.initiatedAt ?? '').localeCompare(a.initiatedAt ?? ''));

    const snap: ExplorerSnapshot = {
      transactions: rows,
      orders: orders.map((o) => o.order),
      sources: {
        transactionSearch: { available: search.searchAvailable, error: search.searchError, count: search.transactions.length, path: search.path },
        demoOrders: {
          tracked: demoIds.length,
          fetched: orders.length,
          errors: demo.filter((d): d is { id: string; error: string } => 'error' in d).map((d) => ({ orderId: d.id, message: d.error })),
        },
      },
      fetchedAt: new Date().toISOString(),
    };
    this.cache = { key, at: Date.now(), snap };
    return snap;
  }
}
