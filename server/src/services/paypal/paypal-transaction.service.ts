import type { PayPalToolRegistry } from './paypal-tool-registry.js';
import { PayPalError, type Money, type NormalizedCapture, type NormalizedOrder, type NormalizedRefund, type NormalizedTransaction, type PayPalPath } from './paypal.types.js';

/* ----------------------------- normalization ----------------------------- */

type AnyObj = Record<string, any>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function toMoney(m: unknown): Money | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as AnyObj;
  const value = str(o.value);
  const currency = str(o.currency_code);
  return value && currency ? { value, currency } : null;
}

const SEARCH_STATUS: Record<string, string> = { S: 'COMPLETED', P: 'PENDING', D: 'DENIED', V: 'REVERSED', F: 'PARTIALLY_REFUNDED' };

/** One Transaction Search `transaction_details[]` entry → internal shape. Missing fields become null. */
export function normalizeSearchTransaction(d: AnyObj): NormalizedTransaction {
  const ti: AnyObj = d?.transaction_info ?? {};
  const rawStatus = str(ti.transaction_status);
  return {
    transactionId: str(ti.transaction_id),
    orderId: null, // Transaction Search does not return the Orders v2 id
    captureId: str(ti.transaction_id),
    status: rawStatus ? (SEARCH_STATUS[rawStatus] ?? rawStatus) : null,
    eventCode: str(ti.transaction_event_code),
    amount: toMoney(ti.transaction_amount),
    fee: toMoney(ti.fee_amount),
    initiatedAt: str(ti.transaction_initiation_date),
    updatedAt: str(ti.transaction_updated_date),
    payerCountry: str(d?.payer_info?.country_code),
    note: str(ti.transaction_note) ?? str(ti.transaction_subject),
    referenceId: str(ti.paypal_reference_id),
    source: 'transaction_search',
  };
}

export function normalizeRefund(r: AnyObj): NormalizedRefund {
  return {
    id: String(r?.id ?? ''),
    captureId: refundCaptureId(r),
    status: str(r?.status),
    amount: toMoney(r?.amount),
    createdAt: str(r?.create_time),
    updatedAt: str(r?.update_time),
    noteToPayer: str(r?.note_to_payer),
  };
}

/** Capture id a refund belongs to, from its HATEOAS "up" link (…/captures/{id}). */
export function refundCaptureId(r: AnyObj): string | null {
  const up = (r?.links ?? []).find((l: AnyObj) => l?.rel === 'up' && typeof l.href === 'string');
  const m = up?.href.match(/\/captures\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Orders v2 GET → internal shape. Captures carry the refunds linked to them. */
export function normalizeOrder(o: AnyObj): NormalizedOrder {
  const units: AnyObj[] = Array.isArray(o?.purchase_units) ? o.purchase_units : [];
  const captures: NormalizedCapture[] = [];
  const refunds: NormalizedRefund[] = [];
  for (const u of units) {
    const payRefunds: AnyObj[] = u?.payments?.refunds ?? [];
    for (const c of (u?.payments?.captures ?? []) as AnyObj[]) {
      captures.push({
        id: String(c.id),
        status: str(c.status),
        amount: toMoney(c.amount),
        finalCapture: typeof c.final_capture === 'boolean' ? c.final_capture : null,
        createdAt: str(c.create_time),
        updatedAt: str(c.update_time),
        refunds: payRefunds.filter((r) => refundCaptureId(r) === c.id).map(normalizeRefund),
      });
    }
    refunds.push(...payRefunds.map(normalizeRefund));
  }
  // If a refund has no "up" link and there's exactly one capture, attribute it to that capture.
  if (captures.length === 1) {
    const linked = new Set(captures[0].refunds.map((r) => r.id));
    for (const r of refunds) if (!linked.has(r.id)) captures[0].refunds.push(r);
  }
  const approve = (o?.links ?? []).find((l: AnyObj) => l?.rel === 'approve' || l?.rel === 'payer-action');
  return {
    id: String(o?.id ?? ''),
    status: str(o?.status),
    intent: str(o?.intent),
    createdAt: str(o?.create_time),
    updatedAt: str(o?.update_time),
    amount: toMoney(units[0]?.amount),
    description: str(units[0]?.description),
    captures,
    refunds,
    approveUrl: str(approve?.href),
  };
}

/** Projects an order onto the transaction-list shape (one row per capture, or one row if uncaptured). */
export function orderToTransactions(order: NormalizedOrder): NormalizedTransaction[] {
  const base = {
    orderId: order.id,
    fee: null,
    payerCountry: null,
    note: order.description,
    eventCode: null,
    source: 'demo_order' as const,
  };
  if (order.captures.length === 0) {
    return [{ ...base, transactionId: null, captureId: null, status: order.status, amount: order.amount, initiatedAt: order.createdAt, updatedAt: order.updatedAt }];
  }
  return order.captures.map((c) => ({
    ...base,
    transactionId: c.id,
    captureId: c.id,
    status: c.status,
    amount: c.amount,
    initiatedAt: c.createdAt ?? order.createdAt,
    updatedAt: c.updatedAt ?? order.updatedAt,
  }));
}

/* ------------------------------ date windows ----------------------------- */

const DAY_MS = 86_400_000;

/** Splits [from, to] into windows of at most 31 days (Transaction Search limit). Newest first. */
export function chunkDateRange(from: Date, to: Date, maxDays = 31): { start: Date; end: Date }[] {
  if (from > to) throw new RangeError('from must be <= to');
  const out: { start: Date; end: Date }[] = [];
  let end = to;
  while (end > from) {
    const start = new Date(Math.max(from.getTime(), end.getTime() - maxDays * DAY_MS + 1000));
    out.push({ start, end });
    end = new Date(start.getTime() - 1000);
  }
  if (out.length === 0) out.push({ start: from, end: to });
  return out;
}

/* -------------------------------- service -------------------------------- */

export interface SearchOutcome {
  transactions: NormalizedTransaction[];
  searchAvailable: boolean;
  searchError: { code: string; httpStatus: number | null; message: string } | null;
  path: PayPalPath | null;
}

export const TRANSACTION_SEARCH_403_HINT =
  'Enable Transaction Search for your Sandbox app in the PayPal Developer Dashboard, then regenerate credentials.';

export class PayPalTransactionService {
  constructor(private readonly registry: PayPalToolRegistry) {}

  async getOrder(orderId: string): Promise<{ order: NormalizedOrder; raw: unknown; path: PayPalPath }> {
    const { data, path } = await this.registry.read<AnyObj>('get_order', { id: orderId });
    return { order: normalizeOrder(data), raw: data, path };
  }

  async getTransactionById(transactionId: string): Promise<{ transaction: NormalizedTransaction | null; path: PayPalPath }> {
    const { data, path } = await this.registry.read<AnyObj>('list_transactions', { transaction_id: transactionId });
    const first = (data?.transaction_details ?? [])[0];
    return { transaction: first ? normalizeSearchTransaction(first) : null, path };
  }

  /**
   * Transaction Search over an arbitrary range, chunked into ≤31-day windows and paged.
   * A 403 is reported (with the dashboard hint), never papered over.
   */
  async search(opts: { from: Date; to: Date; status?: 'S' | 'P' | 'D' | 'V'; maxPages?: number }): Promise<SearchOutcome> {
    const windows = chunkDateRange(opts.from, opts.to);
    const all: NormalizedTransaction[] = [];
    let path: PayPalPath | null = null;
    try {
      for (const w of windows) {
        let page = 1;
        let totalPages = 1;
        do {
          const args: Record<string, unknown> = {
            start_date: w.start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            end_date: w.end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            page,
            page_size: 100,
          };
          if (opts.status) args.transaction_status = opts.status;
          const res = await this.registry.read<AnyObj>('list_transactions', args);
          path = res.path;
          for (const d of res.data?.transaction_details ?? []) all.push(normalizeSearchTransaction(d));
          totalPages = Number(res.data?.total_pages ?? 1) || 1;
          page += 1;
        } while (page <= Math.min(totalPages, opts.maxPages ?? 5));
      }
      return { transactions: all, searchAvailable: true, searchError: null, path };
    } catch (e) {
      if (e instanceof PayPalError) {
        return {
          transactions: all,
          searchAvailable: false,
          searchError: {
            code: e.code,
            httpStatus: e.httpStatus,
            message: e.httpStatus === 403 ? `${e.message}. ${TRANSACTION_SEARCH_403_HINT}` : e.message,
          },
          path,
        };
      }
      throw e;
    }
  }
}
