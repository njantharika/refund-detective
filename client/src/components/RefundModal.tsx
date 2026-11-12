import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, type Deliberation, type Eligibility, type Investigation, type RefundRecord } from '../lib/api';
import { Button, ErrorState, Field, Modal, Notice, Skeleton } from './ui';
import { VerdictBadge } from './CouncilPanel';

export const refundLabel = (amount: string, currency: string) => `Refund ${currency} ${amount}`;

/**
 * Final human gate. Re-validates live on open; the confirm button carries the exact amount and stays
 * disabled until eligibility is verified and the merchant ticks the authorization box.
 */
export function RefundModal({ inv, deliberation, onClose }: { inv: Investigation; deliberation: Deliberation | null; onClose: () => void }) {
  const qc = useQueryClient();
  const open = !!deliberation;
  const exec = deliberation?.executable;
  const [authorized, setAuthorized] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    setAuthorized(false);
    setReason(inv.report?.likelyRootCause.description.slice(0, 200) ?? 'Customer complaint resolved');
  }, [deliberation?.id, inv.report]);

  const live = useQuery({
    queryKey: ['refund-validate', inv.id, deliberation?.id],
    queryFn: () => api<Eligibility>(`/api/investigations/${inv.id}/refund/validate`, { method: 'POST', body: '{}' }),
    enabled: open,
    staleTime: 0,
  });
  const approve = useMutation({
    mutationFn: () =>
      api<RefundRecord>(`/api/investigations/${inv.id}/refund/approve`, {
        method: 'POST',
        body: JSON.stringify({ deliberationId: deliberation!.id, amount: exec!.amount, currency: exec!.currency, reason, confirmationText: refundLabel(exec!.amount, exec!.currency) }),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['investigation', inv.id] });
      qc.invalidateQueries({ queryKey: ['refunds', inv.id] });
      qc.invalidateQueries({ queryKey: ['council', inv.id] });
    },
  });
  const reconcile = useMutation({
    mutationFn: (refundId: string) => api<RefundRecord>(`/api/investigations/${inv.id}/refund/${refundId}/reconcile`, { method: 'POST', body: '{}' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['refunds', inv.id] }),
  });

  if (!deliberation || !exec) return null;
  const fs = live.data?.factSheet;
  const disabledReason = live.isLoading
    ? 'Verifying eligibility with PayPal…'
    : live.error
      ? 'Eligibility could not be verified'
      : live.data && !live.data.eligible
        ? `Not eligible: ${live.data.reasons.join('; ')}`
        : !authorized
          ? 'Tick the authorization box to continue'
          : reason.trim().length === 0
            ? 'Enter a reason'
            : null;
  const result = (reconcile.data ?? approve.data) as RefundRecord | undefined;

  return (
    <Modal open={open} onClose={onClose} title="Review & approve refund" labelledBy="refund-modal-title">
      {result ? (
        <RefundResult r={result} onReconcile={() => reconcile.mutate(result.id)} reconciling={reconcile.isPending} onClose={onClose} />
      ) : (
        <div className="space-y-4">
          <Notice tone="info" icon={ShieldCheck} title="PayPal Sandbox refund">
            This calls PayPal Sandbox <code className="mono">create_refund</code> once, then verifies the result with <code className="mono">get_refund</code>. No real money moves.
          </Notice>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Transaction ID" mono>{inv.transactionId ?? 'Not available'}</Field>
            <Field label="Capture ID" mono>{exec.captureId}</Field>
            {live.isLoading ? (
              <div className="col-span-2">
                <Skeleton className="h-12" />
              </div>
            ) : (
              <>
                <Field label="Original amount">{fs?.capturedAmount ? `${fs.capturedAmount} ${fs.currency}` : 'Not available'}</Field>
                <Field label="Already refunded">{fs?.completedRefundTotal ? `${fs.completedRefundTotal} ${fs.currency}` : 'Not available'}</Field>
                <Field label="Remaining (live)">{fs?.remainingRefundable ? `${fs.remainingRefundable} ${fs.currency}` : 'Not available'}</Field>
              </>
            )}
            <Field label="Proposed refund">
              <span className="font-semibold text-white">
                {exec.amount} {exec.currency}
              </span>
            </Field>
          </dl>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
            Council verdict: <VerdictBadge v={deliberation.finalOutcome} />
            {deliberation.guardrails && !deliberation.guardrails.overridden && <span className="text-xs text-slate-500">guardrails passed</span>}
            {deliberation.guardrails?.overridden && <span className="text-xs text-amber-200">{deliberation.guardrails.overrideReasons[0]}</span>}
          </div>
          <div>
            <label htmlFor="refund-reason" className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Reason (sent as note to payer)
            </label>
            <textarea id="refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} rows={2} className="mt-1 w-full rounded-lg border border-white/10 bg-ink-950 p-2.5 text-sm text-slate-200 focus:border-electric/50 focus:outline-none" />
          </div>
          {live.error && <ErrorState title="Eligibility could not be verified" error={live.error} onRetry={() => live.refetch()} />}
          {live.data && !live.data.eligible && (
            <Notice tone="danger" title="Refund blocked by live checks">
              <ul className="list-disc pl-4">
                {live.data.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Notice>
          )}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/10 p-3 text-sm text-slate-200">
            <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5 h-4 w-4 accent-violet" />I authorize this Sandbox refund
          </label>
          {approve.error && <ErrorState title="Refund not executed" error={approve.error} />}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => approve.mutate()} disabled={!!disabledReason || approve.isPending} aria-describedby="refund-disabled-reason">
              {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {approve.isPending ? 'Refunding…' : refundLabel(exec.amount, exec.currency)}
            </Button>
          </div>
          {disabledReason && (
            <p id="refund-disabled-reason" className="text-right text-xs text-slate-500">
              {disabledReason}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function RefundResult({ r, onReconcile, reconciling, onClose }: { r: RefundRecord; onReconcile: () => void; reconciling: boolean; onClose: () => void }) {
  const ok = r.status === 'completed' || r.status === 'pending';
  return (
    <div className="space-y-4">
      {ok ? (
        <Notice tone="info" icon={CheckCircle2} title={`PayPal Sandbox reports ${r.status.toUpperCase()}`}>
          Refund <span className="mono">{r.paypalRefundId}</span> for {r.amount} {r.currency}, verified with <code className="mono">get_refund</code>.
        </Notice>
      ) : r.status === 'unknown' ? (
        <Notice tone="warning" title="Reconciling with PayPal">
          The outcome is not confirmed yet. The request will not be retried; we reconcile by reading the capture's refunds from PayPal.
        </Notice>
      ) : (
        <Notice tone="danger" title={`Refund ${r.status}`}>
          {r.paypalResponseSummary}
        </Notice>
      )}
      <dl className="grid grid-cols-2 gap-3">
        <Field label="App refund ID" mono>{r.id}</Field>
        <Field label="Idempotency key" mono>{r.idempotencyKey.slice(0, 8)}…</Field>
        <Field label="Approved by">{r.approvedBy}</Field>
        <Field label="Approved at">{new Date(r.approvedAt).toLocaleString()}</Field>
      </dl>
      {r.paypalResponseSummary && <p className="text-xs text-slate-500">{r.paypalResponseSummary}</p>}
      <div className="flex justify-end gap-2">
        {r.status === 'unknown' && (
          <Button variant="outline" onClick={onReconcile} disabled={reconciling}>
            <RefreshCw className={reconciling ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Reconcile now
          </Button>
        )}
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
