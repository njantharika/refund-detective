import type { DB } from '../../database/db.js';
import type { PayPalIntegration } from '../paypal/index.js';
import { PayPalError, type NormalizedDispute, type NormalizedOrder, type NormalizedRefund, type NormalizedTransaction, type PayPalPath } from '../paypal/paypal.types.js';
import type { AppRefundRecord, LockRecord } from './rules.js';

export type EvidenceSource = 'paypal_mcp' | 'paypal_rest' | 'webhook_verified' | 'app_internal' | 'merchant_input';

export interface EvidenceItem {
  id: string; // EV-001
  type: 'order' | 'capture' | 'refund' | 'dispute' | 'transaction_record' | 'webhook_event' | 'app_refund_attempt' | 'operation_lock' | 'merchant_complaint';
  source: EvidenceSource;
  description: string;
  observedAt: string | null;
  original: unknown; // redacted raw payload
  normalized: Record<string, unknown>;
  verified: boolean;
  provenance: { tool: string | null; path: PayPalPath | 'database' | 'merchant' | null; fetchedAt: string };
}

/* -------------------------------- redaction -------------------------------- */

/** Keys holding payer/payee personal data or noise. Removed before evidence is persisted or sent to the LLM. */
const PII_KEYS = new Set(['email_address', 'payer', 'name', 'address', 'phone', 'phone_number', 'shipping', 'payer_info', 'shipping_info', 'birth_date', 'tax_info', 'buyer', 'seller', 'payee', 'links', 'payment_source']);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (PII_KEYS.has(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/* ------------------------------- normalization ------------------------------ */

const srcOf = (path: PayPalPath): EvidenceSource => (path === 'mcp' ? 'paypal_mcp' : 'paypal_rest');
const toolPath = (tool: string, path: PayPalPath, fetchedAt: string) => ({ tool, path, fetchedAt });

export class EvidenceBuilder {
  private items: EvidenceItem[] = [];
  private seq: number;
  /** startAt continues EV numbering after existing evidence (e.g. investigator tool lookups). */
  constructor(
    private readonly fetchedAt = new Date().toISOString(),
    startAt = 0,
  ) {
    this.seq = startAt;
  }

  add(e: Omit<EvidenceItem, 'id'>): EvidenceItem {
    const item = { ...e, id: `EV-${String(++this.seq).padStart(3, '0')}` };
    this.items.push(item);
    return item;
  }
  all() {
    return this.items;
  }
  get time() {
    return this.fetchedAt;
  }

  order(o: NormalizedOrder, raw: unknown, path: PayPalPath) {
    return this.add({
      type: 'order',
      source: srcOf(path),
      description: `Order ${o.id} status ${o.status ?? 'unknown'}, ${o.captures.length} capture(s), amount ${o.amount ? `${o.amount.value} ${o.amount.currency}` : 'unknown'}`,
      observedAt: o.updatedAt ?? o.createdAt,
      original: redact(raw),
      normalized: { orderId: o.id, status: o.status, intent: o.intent, amount: o.amount, description: o.description, createdAt: o.createdAt, updatedAt: o.updatedAt, captureIds: o.captures.map((c) => c.id) },
      verified: true,
      provenance: toolPath('get_order', path, this.fetchedAt),
    });
  }

  capture(c: NormalizedOrder['captures'][number], orderId: string, path: PayPalPath) {
    return this.add({
      type: 'capture',
      source: srcOf(path),
      description: `Capture ${c.id} status ${c.status ?? 'unknown'}, amount ${c.amount ? `${c.amount.value} ${c.amount.currency}` : 'unknown'}`,
      observedAt: c.updatedAt ?? c.createdAt,
      original: null,
      normalized: { captureId: c.id, orderId, status: c.status, amount: c.amount, finalCapture: c.finalCapture, createdAt: c.createdAt, updatedAt: c.updatedAt, refundIds: c.refunds.map((r) => r.id) },
      verified: true,
      provenance: toolPath('get_order', path, this.fetchedAt),
    });
  }

  refund(r: NormalizedRefund, captureId: string | null, path: PayPalPath, tool: 'get_refund' | 'get_order', raw: unknown) {
    return this.add({
      type: 'refund',
      source: srcOf(path),
      description: `Refund ${r.id} status ${r.status ?? 'unknown'}, amount ${r.amount ? `${r.amount.value} ${r.amount.currency}` : 'unknown'}${captureId ? ` on capture ${captureId}` : ''}`,
      observedAt: r.updatedAt ?? r.createdAt,
      original: redact(raw),
      normalized: { refundId: r.id, captureId, status: r.status, amount: r.amount, createdAt: r.createdAt, updatedAt: r.updatedAt, noteToPayer: r.noteToPayer },
      verified: true,
      provenance: toolPath(tool, path, this.fetchedAt),
    });
  }

  dispute(d: NormalizedDispute, path: PayPalPath) {
    return this.add({
      type: 'dispute',
      source: srcOf(path),
      description: `Dispute ${d.id} status ${d.status ?? 'unknown'}, reason ${d.reason ?? 'unknown'}`,
      observedAt: d.updatedAt ?? d.createdAt,
      original: null,
      normalized: { ...d },
      verified: true,
      provenance: toolPath('list_disputes', path, this.fetchedAt),
    });
  }

  transactionRecord(t: NormalizedTransaction, path: PayPalPath) {
    return this.add({
      type: 'transaction_record',
      source: srcOf(path),
      description: `Transaction Search record ${t.transactionId} event ${t.eventCode ?? 'unknown'} status ${t.status ?? 'unknown'}`,
      observedAt: t.updatedAt ?? t.initiatedAt,
      original: null,
      normalized: { ...t },
      verified: true,
      provenance: toolPath('list_transactions', path, this.fetchedAt),
    });
  }
}

/* -------------------------------- collection -------------------------------- */

export interface CollectedEvidence {
  items: EvidenceItem[];
  order: NormalizedOrder | null;
  targetCaptureId: string | null;
  transactionId: string;
  refundLookups: Record<string, NormalizedRefund>;
  disputes: NormalizedDispute[];
  appRefunds: AppRefundRecord[];
  locks: LockRecord[];
  unavailableSources: string[];
}

export const MONEY_CAPTURE_STATUSES = new Set(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING']);

const errMsg = (e: unknown) => (e instanceof PayPalError ? `${e.code}${e.httpStatus ? ` ${e.httpStatus}` : ''}: ${e.message}` : e instanceof Error ? e.message : String(e));

/**
 * Collects all evidence for a target (order ID or capture ID). The backend (not the LLM) decides what to fetch.
 * Failures become entries in unavailableSources ("missing evidence"), never invented data.
 */
export async function collectEvidence(deps: { db: DB; paypal: PayPalIntegration }, input: { targetId: string; captureId?: string | null; complaint: string }): Promise<CollectedEvidence> {
  const { db, paypal } = deps;
  const b = new EvidenceBuilder();
  const unavailable: string[] = [];
  let order: NormalizedOrder | null = null;
  let orderPath: PayPalPath = 'mcp';
  let orderRaw: unknown = null;

  // 1) Resolve the order: the target may itself be an order id, or a capture we know the order for.
  const candidates = [input.targetId];
  const known = db
    .prepare(`SELECT order_id FROM demo_orders UNION SELECT order_id FROM investigations WHERE order_id IS NOT NULL AND (capture_id = ? OR transaction_id = ?)`)
    .pluck()
    .all(input.targetId, input.targetId) as string[];
  for (const id of [...candidates, ...known.filter((k) => k !== input.targetId)]) {
    if (!/^[A-Z0-9]{17,32}$/.test(id)) continue;
    try {
      const r = await paypal.transactions.getOrder(id);
      if (id === input.targetId || r.order.captures.some((c) => c.id === input.targetId)) {
        order = r.order;
        orderRaw = r.raw;
        orderPath = r.path;
        break;
      }
    } catch (e) {
      if (id === input.targetId && !(e instanceof PayPalError && e.httpStatus === 404)) unavailable.push(`get_order ${id}: ${errMsg(e)}`);
    }
  }

  const isCaptureTarget = order ? order.captures.some((c) => c.id === input.targetId) : false;
  // When the target is an order, pick its capture automatically only if exactly one capture actually took money
  // (declined/failed capture attempts stay in the evidence but are never refund targets).
  const moneyCaptures = order?.captures.filter((c) => c.status && MONEY_CAPTURE_STATUSES.has(c.status)) ?? [];
  const targetCaptureId = input.captureId ?? (isCaptureTarget ? input.targetId : moneyCaptures.length === 1 ? moneyCaptures[0].id : null);

  if (order) {
    b.order(order, orderRaw, orderPath);
    for (const c of order.captures) b.capture(c, order.id, orderPath);
  }

  // 2) Refunds. PayPal's get_order response does NOT list refunds (verified live: payments holds only
  //    captures), so refunds are found via (a) any listed on the order and (b) every refund this app created
  //    on these captures, each re-read live with get_refund. Its "up" link ties it to the capture.
  const captureIds = order ? order.captures.map((c) => c.id) : [input.targetId];
  const refundCandidates = new Map<string, string | null>(); // refundId -> captureId (if known)
  for (const c of order?.captures ?? []) for (const r of c.refunds) refundCandidates.set(r.id, c.id);
  const capPh = captureIds.map(() => '?').join(',');
  for (const row of db.prepare(`SELECT paypal_refund_id, capture_id FROM refunds WHERE paypal_refund_id IS NOT NULL AND capture_id IN (${capPh})`).all(...captureIds) as { paypal_refund_id: string; capture_id: string }[]) {
    if (!refundCandidates.has(row.paypal_refund_id)) refundCandidates.set(row.paypal_refund_id, row.capture_id);
  }
  const refundLookups: Record<string, NormalizedRefund> = {};
  for (const [refundId, knownCapture] of [...refundCandidates].slice(0, 20)) {
    try {
      const res = await paypal.refunds.getRefund(refundId);
      const refund = { ...res.refund, captureId: res.refund.captureId ?? knownCapture };
      refundLookups[refundId] = refund;
      b.refund(refund, refund.captureId ?? null, res.path, 'get_refund', null);
    } catch (e) {
      unavailable.push(`get_refund ${refundId}: ${errMsg(e)}`);
      const listed = order?.captures.flatMap((c) => c.refunds).find((r) => r.id === refundId);
      if (listed) b.refund(listed, knownCapture, orderPath, 'get_order', null);
    }
  }

  // 3) Transaction Search record for the capture (may be unavailable: permission or indexing lag).
  const searchId = targetCaptureId ?? (order ? null : input.targetId);
  if (searchId) {
    try {
      const r = await paypal.transactions.getTransactionById(searchId);
      if (r.transaction) b.transactionRecord(r.transaction, r.path);
      else unavailable.push(`Transaction Search has no record for ${searchId} yet (Sandbox indexing can lag by hours)`);
    } catch (e) {
      unavailable.push(`list_transactions ${searchId}: ${errMsg(e)}`);
    }
  }
  if (!order && !b.all().length) unavailable.push(`No PayPal order or transaction found for ${input.targetId}`);

  // 4) Disputes on each capture.
  const disputes: NormalizedDispute[] = [];
  for (const cid of order ? order.captures.map((c) => c.id) : [input.targetId]) {
    try {
      const r = await paypal.disputes.listDisputes({ disputedTransactionId: cid });
      for (const d of r.disputes) {
        disputes.push(d);
        b.dispute(d, r.path);
      }
    } catch (e) {
      unavailable.push(`list_disputes ${cid}: ${errMsg(e)}`);
    }
  }

  // 5) Verified webhook events linked to these resources. Unverified events are never evidence.
  const ids = [input.targetId, order?.id, ...(order?.captures.map((c) => c.id) ?? []), ...Object.keys(refundLookups)].filter(Boolean) as string[];
  const ph = ids.map(() => '?').join(',');
  const relatedClause = ids.map(() => 'related_ids LIKE ?').join(' OR ');
  const events = db
    .prepare(`SELECT id, paypal_event_id, event_type, resource_id, event_time FROM webhook_events WHERE signature_verified = 1 AND (resource_id IN (${ph}) OR ${relatedClause}) ORDER BY event_time`)
    .all(...ids, ...ids.map((x) => `%,${x},%`)) as {
    id: string;
    paypal_event_id: string;
    event_type: string;
    resource_id: string;
    event_time: string;
  }[];
  for (const ev of events) {
    b.add({
      type: 'webhook_event',
      source: 'webhook_verified',
      description: `Verified webhook ${ev.event_type} for ${ev.resource_id}`,
      observedAt: ev.event_time,
      original: null,
      normalized: { eventId: ev.paypal_event_id, eventType: ev.event_type, resourceId: ev.resource_id },
      verified: true,
      provenance: { tool: null, path: 'database', fetchedAt: b.time },
    });
  }
  const webhookCount = db.prepare('SELECT COUNT(*) FROM webhook_events').pluck().get() as number;
  if (webhookCount === 0) unavailable.push('No PayPal webhook events received (webhooks not configured)');

  // 6) In-app refund attempts and locks.
  const appRefunds = (
    db.prepare(`SELECT id, capture_id, amount, currency, status, paypal_refund_id, created_at FROM refunds WHERE capture_id IN (${ph})`).all(...ids) as {
      id: string;
      capture_id: string;
      amount: string;
      currency: string;
      status: AppRefundRecord['status'];
      paypal_refund_id: string | null;
      created_at: string;
    }[]
  ).map((r) => {
    b.add({
      type: 'app_refund_attempt',
      source: 'app_internal',
      description: `In-app refund attempt ${r.id} for ${r.amount} ${r.currency}, status ${r.status}`,
      observedAt: r.created_at,
      original: null,
      normalized: { attemptId: r.id, captureId: r.capture_id, amount: r.amount, currency: r.currency, status: r.status, paypalRefundId: r.paypal_refund_id },
      verified: false,
      provenance: { tool: null, path: 'database', fetchedAt: b.time },
    });
    return { id: r.id, captureId: r.capture_id, amount: r.amount, currency: r.currency, status: r.status, paypalRefundId: r.paypal_refund_id };
  });
  const locks = (db.prepare(`SELECT resource_id, operation, expires_at FROM operation_locks WHERE resource_id IN (${ph})`).all(...ids) as { resource_id: string; operation: string; expires_at: string }[]).map((l) => {
    b.add({
      type: 'operation_lock',
      source: 'app_internal',
      description: `Operation lock "${l.operation}" on ${l.resource_id} until ${l.expires_at}`,
      observedAt: null,
      original: null,
      normalized: { ...l },
      verified: false,
      provenance: { tool: null, path: 'database', fetchedAt: b.time },
    });
    return { resourceId: l.resource_id, operation: l.operation, expiresAt: l.expires_at };
  });

  // 7) The merchant's complaint: an allegation, never verified.
  b.add({
    type: 'merchant_complaint',
    source: 'merchant_input',
    description: 'Customer complaint as entered by the merchant (unverified allegation)',
    observedAt: b.time,
    original: null,
    normalized: { complaint: input.complaint },
    verified: false,
    provenance: { tool: null, path: 'merchant', fetchedAt: b.time },
  });

  return { items: b.all(), order, targetCaptureId, transactionId: targetCaptureId ?? input.targetId, refundLookups, disputes, appRefunds, locks, unavailableSources: unavailable };
}
