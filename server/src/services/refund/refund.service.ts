import { randomUUID } from 'node:crypto';
import { audit, type DB } from '../../database/db.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { PayPalIntegration } from '../paypal/index.js';
import { PayPalError, type NormalizedRefund } from '../paypal/paypal.types.js';
import type { InvestigationService } from '../investigation/investigation.service.js';
import { liveFactSheet } from '../investigation/live.js';
import { checkRefundAmount, type FactSheet } from '../investigation/rules.js';
import { toMinor } from '../investigation/money.js';
import type { CouncilService } from '../council/council.js';

export const LOCK_TTL_MS = 2 * 60_000;
export const confirmationLabel = (amount: string, currency: string) => `Refund ${currency} ${amount}`;

type RefundStatus = 'requested' | 'pending' | 'completed' | 'failed' | 'unknown';
const mapStatus = (s: string | null): RefundStatus => (s === 'COMPLETED' ? 'completed' : s === 'PENDING' ? 'pending' : s === 'FAILED' || s === 'CANCELLED' ? 'failed' : 'unknown');

export interface RefundRow {
  id: string;
  investigation_id: string;
  deliberation_id: string;
  capture_id: string;
  paypal_refund_id: string | null;
  amount: string;
  currency: string;
  reason: string | null;
  status: RefundStatus;
  idempotency_key: string;
  approved_by: string;
  approved_at: string;
  executed_at: string | null;
  paypal_response_summary: string | null;
  created_at: string;
}

export interface Eligibility {
  factSheet: FactSheet;
  eligible: boolean;
  reasons: string[];
  checkedAt: string;
}

export class RefundService {
  constructor(private readonly deps: { db: DB; paypal: PayPalIntegration; investigations: InvestigationService; council: CouncilService }) {}

  /** Re-fetches live and returns the eligibility breakdown. Read-only. */
  async validate(investigationId: string): Promise<Eligibility> {
    const inv = this.deps.investigations.get(investigationId);
    const factSheet = await liveFactSheet(this.deps, { orderId: inv.orderId, captureId: inv.captureId, transactionId: inv.transactionId });
    return { factSheet, eligible: factSheet.refundEligible, reasons: factSheet.refundBlockers, checkedAt: new Date().toISOString() };
  }

  /**
   * The only path that moves money. Steps (all server-side):
   * re-validate live → require a passing council verdict for this exact capture + amount → explicit confirmation →
   * acquire lock → persist `requested` row with idempotency key → create_refund (never retried) → get_refund verify →
   * on unknown outcome: mark `unknown` and reconcile via get_order → release lock → audit.
   */
  async approve(investigationId: string, body: { deliberationId: string; amount: string; currency: string; reason: string; confirmationText: string }) {
    const { db, paypal } = this.deps;
    const inv = this.deps.investigations.get(investigationId);

    // 2) A council verdict that passed guardrails for this exact capture and amount.
    const d = this.deps.council.get(investigationId, body.deliberationId);
    if (d.decisionType !== 'refund') throw new AppError(409, 'NO_REFUND_VERDICT', 'This deliberation is not about a refund');
    if (d.stage !== 'complete' || !d.executable || (d.finalOutcome !== 'APPROVE' && d.finalOutcome !== 'APPROVE_MODIFIED')) {
      throw new AppError(409, 'VERDICT_REQUIRED', `Refund requires a council verdict of APPROVE or APPROVE_MODIFIED that passed guardrails (got ${d.finalOutcome ?? d.stage})`);
    }
    if (d.executable.amount !== body.amount || d.executable.currency !== body.currency) {
      throw new AppError(409, 'AMOUNT_NOT_APPROVED', `The council approved ${d.executable.currency} ${d.executable.amount}, not ${body.currency} ${body.amount}`);
    }
    // Explicit merchant confirmation: the exact label shown on the button.
    if (body.confirmationText !== confirmationLabel(body.amount, body.currency)) throw new AppError(400, 'CONFIRMATION_MISMATCH', `Confirmation must be exactly "${confirmationLabel(body.amount, body.currency)}"`);

    // Idempotency: one executed refund per approved deliberation, ever.
    const prior = db.prepare('SELECT * FROM refunds WHERE deliberation_id = ?').get(d.id) as RefundRow | undefined;
    if (prior) throw new AppError(409, 'ALREADY_EXECUTED', `This approval was already used for refund ${prior.id} (status ${prior.status})`);

    // 1) Re-validate live: state may have changed since the council ran.
    const fs = await liveFactSheet(this.deps, { orderId: inv.orderId, captureId: inv.captureId, transactionId: inv.transactionId });
    if (fs.targetCaptureId !== d.executable.captureId) throw new AppError(409, 'CAPTURE_CHANGED', 'The live capture no longer matches the approved capture');
    if (!fs.refundEligible) throw new AppError(409, 'NOT_ELIGIBLE', `Refund no longer eligible: ${fs.refundBlockers.join('; ')}`);
    const amountCheck = checkRefundAmount(fs, { value: body.amount, currency: body.currency });
    if (!amountCheck.ok) throw new AppError(409, 'AMOUNT_NOT_ELIGIBLE', amountCheck.reason ?? 'Amount not eligible');

    // 3) Lock the capture. A concurrent approval gets 409.
    const captureId = d.executable.captureId;
    if (!this.acquireLock(captureId)) throw new AppError(409, 'LOCKED', 'Another refund operation is in progress for this capture');

    const refundId = `rf_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const idempotencyKey = randomUUID();
    try {
      // 4) Persist the intent before calling PayPal.
      try {
        db.prepare(
          "INSERT INTO refunds (id, investigation_id, deliberation_id, capture_id, amount, currency, reason, status, idempotency_key, approved_by, approved_at) VALUES (?,?,?,?,?,?,?, 'requested', ?, 'merchant', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        ).run(refundId, investigationId, d.id, captureId, body.amount, body.currency, body.reason.slice(0, 500), idempotencyKey);
      } catch (e) {
        if (String(e).includes('UNIQUE')) throw new AppError(409, 'ALREADY_EXECUTED', 'This approval was already used');
        throw e;
      }
      audit(db, {
        actor: 'merchant',
        action: 'refund_approved',
        resourceType: 'refund',
        resourceId: refundId,
        request: { investigationId, deliberationId: d.id, captureId, amount: body.amount, currency: body.currency, confirmation: body.confirmationText, verdict: d.finalOutcome, idempotencyKey },
      });

      // 5) create_refund: exactly once. Never retried on failure or timeout.
      let created: NormalizedRefund | null = null;
      let path: string | null = null;
      try {
        const r = await paypal.refunds.createRefund({ captureId, amount: { value: body.amount, currency: body.currency }, noteToPayer: body.reason, idempotencyKey }, { approved: true });
        created = r.refund;
        path = r.path;
      } catch (e) {
        const definitive = e instanceof PayPalError && e.httpStatus !== null && e.httpStatus >= 400 && e.httpStatus < 500;
        if (definitive) {
          // PayPal rejected the request (e.g. 422): no refund was created.
          this.update(refundId, { status: 'failed', summary: `${(e as PayPalError).code} ${(e as PayPalError).httpStatus}: ${(e as PayPalError).message}` });
          audit(db, { actor: 'system', action: 'refund_failed', resourceType: 'refund', resourceId: refundId, result: (e as Error).message });
          throw new AppError(502, 'PAYPAL_REJECTED', `PayPal rejected the refund: ${(e as Error).message}`);
        }
        // 7) Timeout or unknown result: the refund MAY exist. Mark unknown, do not retry, reconcile.
        this.update(refundId, { status: 'unknown', summary: `Outcome unknown: ${e instanceof Error ? e.message : String(e)}` });
        audit(db, { actor: 'system', action: 'refund_outcome_unknown', resourceType: 'refund', resourceId: refundId, result: e instanceof Error ? e.message : String(e) });
        await this.reconcileRow(refundId).catch((err) => logger.warn({ err: String(err) }, 'reconcile after unknown outcome failed'));
        return this.result(refundId);
      }

      // 6) Verify with get_refund. Only PayPal's own status updates the UI.
      this.update(refundId, { paypalRefundId: created.id, executedAt: true, status: 'unknown', summary: `create_refund returned ${created.id} (${created.status}) via ${path}` });
      try {
        const verified = (await paypal.refunds.getRefund(created.id)).refund;
        this.update(refundId, { status: mapStatus(verified.status), summary: `Verified via get_refund: ${verified.id} ${verified.status} ${verified.amount?.value ?? ''} ${verified.amount?.currency ?? ''}` });
      } catch (e) {
        this.update(refundId, { status: 'unknown', summary: `Refund ${created.id} created; get_refund verification failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      const row = this.row(refundId);
      audit(db, {
        actor: 'system',
        action: 'refund_executed',
        resourceType: 'refund',
        resourceId: refundId,
        request: { tool: 'create_refund', path, captureId, amount: body.amount, currency: body.currency },
        result: { paypalRefundId: row.paypal_refund_id, status: row.status, summary: row.paypal_response_summary },
      });
      if (row.status === 'completed' || row.status === 'pending') db.prepare("UPDATE investigations SET status = 'resolved', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(investigationId);
      return this.result(refundId);
    } finally {
      // 8) Release the lock.
      this.releaseLock(captureId);
    }
  }

  /**
   * Reconciles an `unknown` refund by reading the capture's refunds from get_order (read-only).
   * Matches a PayPal refund on the same capture and amount created after our request that isn't
   * already linked to another row.
   */
  async reconcileRow(refundId: string) {
    const { db, paypal } = this.deps;
    const row = this.row(refundId);
    if (row.status !== 'unknown' && row.status !== 'requested') return this.result(refundId);
    if (row.paypal_refund_id) {
      const r = (await paypal.refunds.getRefund(row.paypal_refund_id)).refund;
      this.update(refundId, { status: mapStatus(r.status), summary: `Reconciled via get_refund: ${r.id} ${r.status}` });
    } else {
      const inv = this.deps.investigations.get(row.investigation_id);
      if (!inv.orderId) return this.result(refundId);
      const order = (await paypal.transactions.getOrder(inv.orderId)).order;
      const capture = order.captures.find((c) => c.id === row.capture_id);
      const linked = new Set(db.prepare('SELECT paypal_refund_id FROM refunds WHERE paypal_refund_id IS NOT NULL').pluck().all() as string[]);
      // Created after our request (5 min tolerance for clock skew between us and PayPal), same amount, not linked elsewhere.
      const notBefore = new Date(row.created_at).getTime() - 5 * 60_000;
      const match = capture?.refunds.find(
        (r) =>
          !linked.has(r.id) &&
          r.amount &&
          r.amount.currency === row.currency &&
          toMinor(r.amount.value, row.currency) === toMinor(row.amount, row.currency) &&
          (!r.createdAt || new Date(r.createdAt).getTime() >= notBefore),
      );
      if (match) this.update(refundId, { paypalRefundId: match.id, status: mapStatus(match.status), summary: `Reconciled via get_order: found refund ${match.id} ${match.status}` });
      else this.update(refundId, { summary: `Reconciling with PayPal: no matching refund on capture ${row.capture_id} yet` });
    }
    audit(db, { actor: 'system', action: 'refund_reconciled', resourceType: 'refund', resourceId: refundId, result: { status: this.row(refundId).status } });
    return this.result(refundId);
  }

  private acquireLock(resourceId: string): boolean {
    const { db } = this.deps;
    return db.transaction(() => {
      const now = new Date();
      const existing = db.prepare('SELECT expires_at FROM operation_locks WHERE resource_id = ?').pluck().get(resourceId) as string | undefined;
      if (existing && new Date(existing) > now) return false;
      db.prepare('INSERT OR REPLACE INTO operation_locks (resource_id, operation, acquired_at, expires_at) VALUES (?, ?, ?, ?)').run(resourceId, 'refund', now.toISOString(), new Date(now.getTime() + LOCK_TTL_MS).toISOString());
      return true;
    })();
  }

  private releaseLock(resourceId: string) {
    this.deps.db.prepare('DELETE FROM operation_locks WHERE resource_id = ?').run(resourceId);
  }

  private update(id: string, u: { status?: RefundStatus; paypalRefundId?: string; executedAt?: boolean; summary?: string }) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (u.status) (sets.push('status = ?'), vals.push(u.status));
    if (u.paypalRefundId) (sets.push('paypal_refund_id = ?'), vals.push(u.paypalRefundId));
    if (u.executedAt) sets.push("executed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    if (u.summary) (sets.push('paypal_response_summary = ?'), vals.push(u.summary.slice(0, 500)));
    if (sets.length) this.deps.db.prepare(`UPDATE refunds SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  row(id: string): RefundRow {
    const r = this.deps.db.prepare('SELECT * FROM refunds WHERE id = ?').get(id) as RefundRow | undefined;
    if (!r) throw new AppError(404, 'NOT_FOUND', `Refund ${id} not found`);
    return r;
  }

  result(id: string) {
    const r = this.row(id);
    return {
      id: r.id,
      investigationId: r.investigation_id,
      deliberationId: r.deliberation_id,
      captureId: r.capture_id,
      paypalRefundId: r.paypal_refund_id,
      amount: r.amount,
      currency: r.currency,
      reason: r.reason,
      status: r.status,
      idempotencyKey: r.idempotency_key,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      executedAt: r.executed_at,
      paypalResponseSummary: r.paypal_response_summary,
      createdAt: r.created_at,
      reconciling: r.status === 'unknown',
    };
  }

  list() {
    return (this.deps.db.prepare('SELECT id FROM refunds ORDER BY created_at DESC LIMIT 200').pluck().all() as string[]).map((id) => this.result(id));
  }

  forInvestigation(investigationId: string) {
    return (this.deps.db.prepare('SELECT id FROM refunds WHERE investigation_id = ? ORDER BY created_at DESC').pluck().all(investigationId) as string[]).map((id) => this.result(id));
  }
}
