/**
 * Deterministic analysis. Pure functions, no I/O. The LLM may interpret the FactSheet
 * but never overrides it; the council guardrails and the refund flow re-run it live.
 */
import type { NormalizedCapture, NormalizedDispute, NormalizedOrder, NormalizedRefund, Money } from '../paypal/paypal.types.js';
import { OPEN_DISPUTE_STATUSES } from '../paypal/paypal-dispute.service.js';
import { fromMinor, toMinor } from './money.js';

export interface AppRefundRecord {
  id: string;
  captureId: string;
  amount: string;
  currency: string;
  status: 'requested' | 'pending' | 'completed' | 'failed' | 'unknown';
  paypalRefundId: string | null;
}

export interface LockRecord {
  resourceId: string;
  operation: string;
  expiresAt: string;
}

export interface FactSheetInput {
  order: NormalizedOrder | null;
  targetCaptureId: string | null;
  /** Fresh refund lookups (get_refund) by id; override the status embedded in the order when present. */
  refundLookups?: Record<string, NormalizedRefund>;
  disputes: NormalizedDispute[];
  appRefunds: AppRefundRecord[];
  locks: LockRecord[];
  now?: Date;
  /** Sources we tried but could not read (e.g. "transaction_search: 403"). */
  unavailableSources?: string[];
}

export interface FactSheet {
  targetCaptureId: string | null;
  orderId: string | null;
  orderStatus: string | null;
  captureStatus: string | null;
  captureCount: number;
  currency: string | null;
  capturedAmount: string | null;
  completedRefundTotal: string | null;
  pendingRefundTotal: string | null;
  remainingRefundable: string | null;
  refunds: { id: string; status: string | null; amount: string | null; currency: string | null }[];
  openDisputes: string[];
  hasOpenDispute: boolean;
  appPendingRefund: boolean;
  appRefundsUnknown: boolean;
  lockHeld: boolean;
  currencyMismatch: boolean;
  conflictingStatuses: string[];
  missingEvidence: string[];
  /** Plain-language reasons a refund must not proceed right now (empty means eligible on the facts). */
  refundBlockers: string[];
  refundEligible: boolean;
  refundTotalsUnverified: boolean;
  computedAt: string;
}

const PENDING_REFUND = new Set(['PENDING']);
const COMPLETED_REFUND = new Set(['COMPLETED']);
const NON_REFUNDABLE_CAPTURE = new Set(['DECLINED', 'FAILED', 'PENDING']);

export function pickCapture(order: NormalizedOrder | null, targetCaptureId: string | null): NormalizedCapture | null {
  if (!order) return null;
  if (targetCaptureId) return order.captures.find((c) => c.id === targetCaptureId) ?? null;
  return order.captures.length === 1 ? order.captures[0] : null;
}

export function computeFactSheet(input: FactSheetInput): FactSheet {
  const now = input.now ?? new Date();
  const capture = pickCapture(input.order, input.targetCaptureId);
  const captureId = capture?.id ?? input.targetCaptureId;
  const currency = capture?.amount?.currency ?? input.order?.amount?.currency ?? null;
  const missing: string[] = [...(input.unavailableSources ?? [])];
  const conflicts: string[] = [];
  const blockers: string[] = [];

  if (!input.order) missing.push('Order record (get_order) not available');
  if (input.order && input.order.captures.length > 1 && !input.targetCaptureId) missing.push('Order has multiple captures that took money; select one to investigate');
  if (input.order && input.order.captures.length === 0) missing.push('Order has no captures: payment was never captured');
  if (input.targetCaptureId && input.order && !capture) conflicts.push(`Capture ${input.targetCaptureId} is not part of order ${input.order.id}`);

  // Refunds on the target capture: those listed on the order (fresh get_refund status wins) plus refunds
  // found via get_refund whose PayPal "up" link points at this capture.
  const listed = (capture?.refunds ?? []).map((r) => input.refundLookups?.[r.id] ?? r);
  const listedIds = new Set(listed.map((r) => r.id));
  const extra = capture ? Object.values(input.refundLookups ?? {}).filter((r) => r.captureId === capture.id && !listedIds.has(r.id)) : [];
  const refunds: NormalizedRefund[] = [...listed, ...extra];
  let completedMinor = 0;
  let pendingMinor = 0;
  let currencyMismatch = false;
  for (const r of refunds) {
    if (!r.amount || !currency) continue;
    if (r.amount.currency !== currency) {
      currencyMismatch = true;
      conflicts.push(`Refund ${r.id} is in ${r.amount.currency} but the capture is in ${currency}`);
      continue;
    }
    if (r.status && COMPLETED_REFUND.has(r.status)) completedMinor += toMinor(r.amount.value, currency);
    else if (r.status && PENDING_REFUND.has(r.status)) pendingMinor += toMinor(r.amount.value, currency);
    if (!r.status) missing.push(`Status of refund ${r.id} is unknown`);
  }

  // App-side refund attempts that PayPal may not reflect yet.
  const appForCapture = input.appRefunds.filter((a) => a.captureId === captureId);
  const reflected = new Set(refunds.map((r) => r.id));
  for (const a of appForCapture) {
    if ((a.status === 'requested' || a.status === 'pending' || a.status === 'unknown') && !(a.paypalRefundId && reflected.has(a.paypalRefundId))) {
      if (currency && a.currency === currency) pendingMinor += toMinor(a.amount, currency);
    }
  }
  const appPendingRefund = appForCapture.some((a) => a.status === 'requested' || a.status === 'pending');
  const appRefundsUnknown = appForCapture.some((a) => a.status === 'unknown');
  const lockHeld = input.locks.some((l) => l.resourceId === captureId && new Date(l.expiresAt) > now);

  const capturedMinor = capture?.amount && currency ? toMinor(capture.amount.value, currency) : null;
  let remainingMinor = capturedMinor !== null ? Math.max(0, capturedMinor - completedMinor - pendingMinor) : null;

  // Fail safe: PayPal's capture status is authoritative about refunds we cannot see (e.g. refunds made in the
  // PayPal dashboard, which get_order does not list). Never compute "remaining" from an incomplete picture.
  let refundTotalsUnverified = false;
  if (capture?.status === 'REFUNDED' && capturedMinor !== null) remainingMinor = 0;
  if (capture?.status === 'PARTIALLY_REFUNDED' && refunds.length === 0) {
    refundTotalsUnverified = true;
    remainingMinor = null;
    missing.push('PayPal reports this capture PARTIALLY_REFUNDED, but the refund records are not visible to the app (e.g. refunded outside Refund Detective)');
  }

  // Status consistency between the capture and the refund records.
  if (capture && capturedMinor !== null) {
    if (capture.status === 'REFUNDED' && completedMinor < capturedMinor) conflicts.push(`Capture status is REFUNDED but completed refunds total ${fromMinor(completedMinor, currency!)} of ${capture.amount!.value}`);
    if (capture.status === 'PARTIALLY_REFUNDED' && completedMinor === 0) conflicts.push('Capture status is PARTIALLY_REFUNDED but no completed refund is recorded');
    if (capture.status === 'COMPLETED' && completedMinor > 0) conflicts.push('Capture status is COMPLETED although completed refunds exist');
    if (completedMinor > capturedMinor) conflicts.push('Completed refunds exceed the captured amount');
  }

  const openDisputes = input.disputes.filter((d) => d.status && OPEN_DISPUTE_STATUSES.has(d.status)).map((d) => d.id);

  if (!capture) blockers.push('No capture identified: refunds target capture IDs, not order IDs');
  else if (capture.status && NON_REFUNDABLE_CAPTURE.has(capture.status)) blockers.push(`Capture status ${capture.status} is not refundable`);
  if (remainingMinor !== null && remainingMinor <= 0) blockers.push('Nothing left to refund: remaining refundable amount is 0');
  if (refundTotalsUnverified) blockers.push('Remaining refundable cannot be verified: PayPal reports a partial refund the app cannot see');
  if (pendingMinor > 0 || appPendingRefund) blockers.push('A refund is already in progress for this capture');
  if (appRefundsUnknown) blockers.push('A previous refund attempt has an unknown outcome and must be reconciled first');
  if (lockHeld) blockers.push('Another refund operation holds the lock on this capture');
  if (openDisputes.length) blockers.push(`Open dispute(s) ${openDisputes.join(', ')}: resolve via the dispute flow`);
  if (currencyMismatch) blockers.push('Currency mismatch between capture and refunds');

  const m = (v: number | null) => (v === null || !currency ? null : fromMinor(v, currency));
  return {
    targetCaptureId: captureId ?? null,
    orderId: input.order?.id ?? null,
    orderStatus: input.order?.status ?? null,
    captureStatus: capture?.status ?? null,
    captureCount: input.order?.captures.length ?? 0,
    currency,
    capturedAmount: m(capturedMinor),
    completedRefundTotal: capture && !refundTotalsUnverified ? m(completedMinor) : null,
    pendingRefundTotal: capture ? m(pendingMinor) : null,
    remainingRefundable: m(remainingMinor),
    refunds: refunds.map((r) => ({ id: r.id, status: r.status, amount: r.amount?.value ?? null, currency: r.amount?.currency ?? null })),
    openDisputes,
    hasOpenDispute: openDisputes.length > 0,
    appPendingRefund,
    appRefundsUnknown,
    lockHeld,
    currencyMismatch,
    conflictingStatuses: conflicts,
    missingEvidence: [...new Set(missing)],
    refundBlockers: blockers,
    refundEligible: blockers.length === 0,
    refundTotalsUnverified,
    computedAt: now.toISOString(),
  };
}

/** Validates a proposed refund amount against the FactSheet. Used by the council guardrails and the approve flow. */
export function checkRefundAmount(fs: FactSheet, proposed: Money): { ok: boolean; reason: string | null; cappedTo: string | null } {
  if (!fs.currency || fs.remainingRefundable === null) return { ok: false, reason: 'Refundable amount could not be computed', cappedTo: null };
  if (proposed.currency !== fs.currency) return { ok: false, reason: `Currency mismatch: proposed ${proposed.currency}, capture is ${fs.currency}`, cappedTo: null };
  let p: number;
  try {
    p = toMinor(proposed.value, fs.currency);
  } catch (e) {
    return { ok: false, reason: (e as Error).message, cappedTo: null };
  }
  const remaining = toMinor(fs.remainingRefundable, fs.currency);
  if (p <= 0) return { ok: false, reason: 'Refund amount must be greater than zero', cappedTo: null };
  if (remaining <= 0) return { ok: false, reason: 'Nothing left to refund', cappedTo: null };
  if (p > remaining) return { ok: false, reason: `Amount ${proposed.value} exceeds remaining refundable ${fs.remainingRefundable}`, cappedTo: fs.remainingRefundable };
  return { ok: true, reason: null, cappedTo: null };
}
