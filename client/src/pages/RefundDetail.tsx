import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ClipboardList, Gavel, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, type RefundRecord, type Refund, type Verdict } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Button, Card, ErrorState, Field, Notice, Pill, Skeleton, StatusBadge } from '../components/ui';
import { VerdictBadge } from '../components/CouncilPanel';

interface RefundDetails {
  refund: RefundRecord;
  paypal: { refund: Refund & { captureId?: string | null }; path: string; checkedAt: string } | null;
  paypalError: string | null;
  deliberation: {
    id: string;
    proposal: string;
    finalOutcome: Verdict | null;
    judgeVerdict: Verdict | null;
    judgeConfidence: number | null;
    rationale: string | null;
    strongestDissent: string | null;
    guardrailsOverridden: boolean | null;
    checks: { rule: string; passed: boolean; detail: string }[];
    advocateModel: string | null;
    challengerModel: string | null;
    completedAt: string | null;
  } | null;
  investigation: { id: string; orderId: string | null; captureId: string | null; summary: string | null; complaint: string | null } | null;
  audit: { actor: string; action: string; resourceType: string; request: string | null; result: string | null; createdAt: string }[];
}

const short = (s: string | null) => {
  if (!s) return '';
  try {
    const o = JSON.parse(s);
    return typeof o === 'string' ? o : Object.entries(o).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  } catch {
    return s;
  }
};

export function RefundDetailPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['refund-details', id], queryFn: () => api<RefundDetails>(`/api/refunds/${id}/details`) });
  const d = q.data;
  const r = d?.refund;
  const live = d?.paypal?.refund;
  const mismatch = !!(r && live && live.status && r.status.toUpperCase() !== live.status);

  return (
    <>
      <div className="mb-3">
        <Link to="/refunds" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
          <ArrowLeft className="h-3.5 w-3.5" /> All refunds
        </Link>
      </div>
      <PageHeader
        title={r ? `Refund ${r.currency} ${r.amount}` : 'Refund'}
        subtitle={<span className="mono text-slate-400">{id}</span>}
        actions={
          <Button variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={q.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Re-check with PayPal
          </Button>
        }
      />
      {q.error && <ErrorState title="Could not load this refund" error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading && <Skeleton className="h-64" />}
      {d && r && (
        <div className="grid gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <Card title="PayPal (live)" subtitle={d.paypal ? `get_refund via ${d.paypal.path === 'mcp' ? 'MCP' : 'REST fallback'} · checked ${dateTime(d.paypal.checkedAt)}` : 'Not yet confirmed by PayPal'} actions={live ? <StatusBadge status={live.status} /> : undefined}>
              {d.paypalError && <ErrorState title="PayPal lookup failed" error={d.paypalError} />}
              {!r.paypalRefundId && (
                <Notice tone="warning" title="Reconciling with PayPal">
                  No PayPal refund ID is linked yet. The request is never retried; the app reconciles by reading PayPal.
                </Notice>
              )}
              {live && (
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="PayPal refund ID" mono>{live.id}</Field>
                  <Field label="Amount">{money(live.amount)}</Field>
                  <Field label="Status">{live.status ?? 'Not available'}</Field>
                  <Field label="Capture" mono>{live.captureId ?? r.captureId}</Field>
                  <Field label="Created">{dateTime(live.createdAt)}</Field>
                  <Field label="Updated">{dateTime(live.updatedAt)}</Field>
                  <Field label="Note to payer">{live.noteToPayer ?? 'Not available'}</Field>
                </dl>
              )}
              {mismatch && (
                <div className="mt-4">
                  <Notice tone="warning" title="PayPal's status differs from the app record">
                    App record: {r.status}. PayPal now reports {live?.status}. PayPal is the source of truth.
                  </Notice>
                </div>
              )}
            </Card>

            <Card title="Authorisation" subtitle="Why this refund was allowed to execute">
              {d.deliberation ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
                    <Gavel aria-hidden className="h-4 w-4 text-violet-300" /> Council verdict <VerdictBadge v={d.deliberation.finalOutcome} />
                    {d.deliberation.judgeConfidence !== null && (
                      <span className="text-xs text-slate-400">
                        Judge confidence {Math.round(d.deliberation.judgeConfidence * 100)}% <span className="text-slate-500">(estimate)</span>
                      </span>
                    )}
                    <Pill tone={d.deliberation.guardrailsOverridden ? 'warning' : 'success'} icon={ShieldCheck}>
                      {d.deliberation.guardrailsOverridden ? 'guardrails modified the verdict' : 'guardrails passed'}
                    </Pill>
                  </div>
                  <p className="text-sm text-slate-400">Debated: {d.deliberation.proposal}</p>
                  {d.deliberation.rationale && <p className="text-sm text-slate-200">{d.deliberation.rationale}</p>}
                  {d.deliberation.strongestDissent && (
                    <p className="text-sm text-slate-400">
                      <b className="text-slate-300">Strongest dissent:</b> {d.deliberation.strongestDissent}
                    </p>
                  )}
                  <ul className="space-y-0.5 text-xs text-slate-400">
                    {d.deliberation.checks.map((c, i) => (
                      <li key={i} className="flex gap-2">
                        {c.passed ? <Check aria-label="passed" className="h-3.5 w-3.5 shrink-0 text-teal" /> : <X aria-label="failed" className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
                        <span className="mono text-slate-500">{c.rule}</span> {c.detail}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-slate-500">
                    Advocate {d.deliberation.advocateModel ?? '—'} · Challenger {d.deliberation.challengerModel ?? '—'} · {d.deliberation.id}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-500">The authorising deliberation is not available.</p>
              )}
            </Card>

            <Card title="Audit trail" subtitle="Investigation → council → approval → execution" padded={false}>
              <ol className="divide-y divide-white/[0.04]">
                {d.audit.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3 text-sm">
                    <span className="w-36 shrink-0 text-xs text-slate-500">{dateTime(a.createdAt)}</span>
                    <span className="mono w-32 shrink-0 text-xs text-violet-300">{a.actor}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-slate-200">{a.action.replace(/_/g, ' ')}</span>
                      {(a.result || a.request) && <span className="block truncate text-xs text-slate-500" title={a.result ?? a.request ?? ''}>{short(a.result ?? a.request)}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="App record">
              <dl className="grid grid-cols-1 gap-3">
                <Field label="Status (app)">
                  <StatusBadge status={r.status === 'unknown' ? 'RECONCILING' : r.status.toUpperCase()} />
                </Field>
                <Field label="Amount">
                  {r.amount} {r.currency}
                </Field>
                <Field label="Capture" mono>{r.captureId}</Field>
                <Field label="Reason">{r.reason ?? '—'}</Field>
                <Field label="Approved by">{r.approvedBy}</Field>
                <Field label="Approved at">{dateTime(r.approvedAt)}</Field>
                <Field label="Executed at">{dateTime(r.executedAt)}</Field>
                <Field label="Idempotency key" mono>{r.idempotencyKey}</Field>
                <Field label="Verification">{r.paypalResponseSummary ?? '—'}</Field>
              </dl>
            </Card>
            {d.investigation && (
              <Card title="Case">
                <p className="text-sm text-slate-300">{d.investigation.summary ?? 'No summary'}</p>
                {d.investigation.complaint && <p className="mt-2 text-xs italic text-slate-500">“{d.investigation.complaint}”</p>}
                <Link to={`/investigations/${d.investigation.id}`}>
                  <Button variant="outline" className="mt-3 w-full">
                    <ClipboardList className="h-4 w-4" /> Open investigation
                  </Button>
                </Link>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
