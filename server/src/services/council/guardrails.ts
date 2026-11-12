/**
 * Deterministic guardrails. They run AFTER the Judge and can only make the outcome stricter.
 * No verdict executes anything: APPROVE / APPROVE_MODIFIED merely unlocks the merchant approval modal.
 */
import { checkRefundAmount, type FactSheet } from '../investigation/rules.js';
import { toMinor } from '../investigation/money.js';
import type { CouncilDecisionType, JudgeVerdict, Proposal, Verdict } from './schemas.js';

export const MIN_JUDGE_CONFIDENCE = 0.6;

/** Strictness order. A guardrail may move the outcome right, never left. */
const STRICTNESS: Record<Verdict, number> = { APPROVE: 0, APPROVE_MODIFIED: 1, NEEDS_MORE_INFO: 2, ESCALATE_TO_HUMAN: 3, REJECT: 4 };
export const stricter = (a: Verdict, b: Verdict): Verdict => (STRICTNESS[b] > STRICTNESS[a] ? b : a);

export interface GuardrailCheck {
  rule: string;
  passed: boolean;
  outcome: Verdict | null; // the outcome this rule forces when it fails
  detail: string;
}

export interface GuardrailResult {
  judgeVerdict: Verdict | null;
  finalOutcome: Verdict;
  overridden: boolean;
  overrideReasons: string[];
  checks: GuardrailCheck[];
  executable: { amount: string; currency: string; captureId: string } | null;
  /** Set only for an approved dispute_accept decision that passed every check. */
  executableDispute: { disputeId: string } | null;
}

const minAmount = (a: string, b: string, currency: string) => (toMinor(a, currency) <= toMinor(b, currency) ? a : b);

export function applyGuardrails(input: { decisionType: CouncilDecisionType; proposal: Proposal; judge: JudgeVerdict | null; factSheet: FactSheet; failure?: string | null }): GuardrailResult {
  const { proposal, judge, factSheet: fs } = input;
  const checks: GuardrailCheck[] = [];
  const reasons: string[] = [];
  let outcome: Verdict = judge?.verdict ?? 'ESCALATE_TO_HUMAN';
  const force = (rule: string, v: Verdict, detail: string) => {
    checks.push({ rule, passed: false, outcome: v, detail });
    const next = stricter(outcome, v);
    if (next !== outcome) reasons.push(`${rule}: ${detail}`);
    outcome = next;
  };
  const pass = (rule: string, detail: string) => checks.push({ rule, passed: true, outcome: null, detail });

  // A council where either side failed is never ruled on one-sidedly.
  if (input.failure || !judge) {
    const why = input.failure ?? 'The Judge did not produce a verdict';
    force('council_complete', 'ESCALATE_TO_HUMAN', why);
    if (!reasons.length) reasons.push(`council_complete: ${why}`);
    return { judgeVerdict: judge?.verdict ?? null, finalOutcome: outcome, overridden: true, overrideReasons: reasons, checks, executable: null, executableDispute: null };
  }

  if (judge.confidence < MIN_JUDGE_CONFIDENCE) force('judge_confidence', 'NEEDS_MORE_INFO', `Judge confidence ${judge.confidence.toFixed(2)} is below ${MIN_JUDGE_CONFIDENCE}`);
  else pass('judge_confidence', `Judge confidence ${judge.confidence.toFixed(2)} ≥ ${MIN_JUDGE_CONFIDENCE}`);

  let executable: GuardrailResult['executable'] = null;

  if (input.decisionType === 'refund') {
    const remaining = fs.remainingRefundable;
    if (remaining === null || !fs.currency) force('refundable_known', 'REJECT', 'Remaining refundable amount could not be computed from PayPal data');
    else if (toMinor(remaining, fs.currency) <= 0) force('remaining_refundable', 'REJECT', `Remaining refundable is ${remaining} ${fs.currency}: nothing left to refund`);
    else pass('remaining_refundable', `Remaining refundable ${remaining} ${fs.currency}`);

    if (fs.pendingRefundTotal && fs.currency && toMinor(fs.pendingRefundTotal, fs.currency) > 0) force('no_refund_in_progress', 'REJECT', `Refund already in progress (${fs.pendingRefundTotal} ${fs.currency} pending)`);
    else if (fs.appPendingRefund || fs.lockHeld) force('no_refund_in_progress', 'REJECT', 'Refund already in progress (in-app request or lock held)');
    else if (fs.appRefundsUnknown) force('no_refund_in_progress', 'REJECT', 'A previous refund attempt has an unknown outcome; reconcile with PayPal first');
    else pass('no_refund_in_progress', 'No pending refund, unknown attempt or lock');

    if (fs.hasOpenDispute) force('no_open_dispute', 'ESCALATE_TO_HUMAN', `Open dispute ${fs.openDisputes.join(', ')}: resolve via the dispute flow (refunding now risks double loss)`);
    else pass('no_open_dispute', 'No open disputes on this transaction');

    if (fs.currencyMismatch) force('currency_consistent', 'REJECT', 'Currency mismatch between capture and refunds');
    if (!fs.targetCaptureId || (proposal.captureId && proposal.captureId !== fs.targetCaptureId)) force('capture_matches', 'REJECT', 'Proposal does not target the investigated capture');
    else pass('capture_matches', `Targets capture ${fs.targetCaptureId}`);

    const approving = outcome === 'APPROVE' || outcome === 'APPROVE_MODIFIED';
    if (approving) {
      if (judge.decision.type !== 'refund') force('decision_consistent', 'REJECT', `Verdict ${judge.verdict} but decision type is ${judge.decision.type}`);
      else {
        const currency = judge.decision.currency ?? proposal.currency ?? fs.currency;
        // The Judge may lower the amount, never raise it above the proposal.
        const requested = judge.decision.amount ?? proposal.amount ?? remaining;
        if (!currency || !requested) force('amount_defined', 'REJECT', 'No refund amount defined');
        else if (currency !== fs.currency) force('currency_consistent', 'REJECT', `Currency mismatch: decision ${currency}, capture ${fs.currency}`);
        else {
          let amount = proposal.amount ? minAmount(requested, proposal.amount, currency) : requested;
          const check = checkRefundAmount(fs, { value: amount, currency });
          if (!check.ok && check.cappedTo) {
            force('amount_within_remaining', 'APPROVE_MODIFIED', `${check.reason}; capped to ${check.cappedTo}`);
            amount = check.cappedTo;
          } else if (!check.ok) force('amount_within_remaining', 'REJECT', check.reason ?? 'Invalid amount');
          else pass('amount_within_remaining', `${amount} ${currency} ≤ remaining ${remaining}`);
          if (outcome === 'APPROVE' || outcome === 'APPROVE_MODIFIED') executable = { amount, currency, captureId: fs.targetCaptureId! };
        }
      }
    }
  }

  let executableDispute: GuardrailResult['executableDispute'] = null;
  if (input.decisionType === 'dispute_accept') {
    const disputeId = proposal.disputeId;
    // Accepting a claim refunds the buyer through PayPal, so the same double-loss protections apply.
    if (!disputeId || !fs.openDisputes.includes(disputeId)) force('dispute_open', 'REJECT', `Dispute ${disputeId ?? '(none)'} is not open on this transaction according to live PayPal data`);
    else pass('dispute_open', `Dispute ${disputeId} is open`);
    if ((fs.pendingRefundTotal && fs.currency && toMinor(fs.pendingRefundTotal, fs.currency) > 0) || fs.appPendingRefund || fs.lockHeld || fs.appRefundsUnknown)
      force('no_refund_in_progress', 'REJECT', 'A refund is in progress on this capture; accepting the claim too could cause double loss');
    else pass('no_refund_in_progress', 'No refund in progress');
    const approving = outcome === 'APPROVE' || outcome === 'APPROVE_MODIFIED';
    if (approving && judge.decision.type !== 'dispute_accept') force('decision_consistent', 'REJECT', `Verdict ${judge.verdict} but decision type is ${judge.decision.type}`);
    if ((outcome === 'APPROVE' || outcome === 'APPROVE_MODIFIED') && disputeId) executableDispute = { disputeId };
  }

  if (outcome !== 'APPROVE' && outcome !== 'APPROVE_MODIFIED') {
    executable = null;
    executableDispute = null;
  }
  return { judgeVerdict: judge.verdict, finalOutcome: outcome, overridden: outcome !== judge.verdict, overrideReasons: reasons, checks, executable, executableDispute };
}
