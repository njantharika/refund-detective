import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FileSearch, Plus } from 'lucide-react';
import { api, type InvestigationListItem, type TransactionDetails } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Button, Card, EmptyState, ErrorState, Notice, Skeleton, StatusBadge } from '../components/ui';

export const STAGE_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  collecting: { label: 'COLLECTING', tone: 'info' },
  analyzing: { label: 'ANALYZING', tone: 'info' },
  ready: { label: 'REPORT READY', tone: 'success' },
  failed: { label: 'FAILED', tone: 'danger' },
  ai_unavailable: { label: 'AI NOT CONFIGURED', tone: 'warning' },
};

export function InvestigationsPage() {
  const list = useQuery({ queryKey: ['investigations'], queryFn: () => api<{ items: InvestigationListItem[] }>('/api/investigations'), refetchInterval: 5000 });
  return (
    <>
      <PageHeader
        title="Investigations"
        subtitle="Evidence-first case files for payment complaints."
        actions={
          <Link to="/transactions">
            <Button>
              <Plus className="h-4 w-4" /> New from a transaction
            </Button>
          </Link>
        }
      />
      {list.error && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
      <Card padded={false}>
        {list.isLoading && (
          <div className="space-y-3 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {list.data && list.data.items.length === 0 && (
          <EmptyState icon={FileSearch} title="No investigations yet">
            Open a transaction and choose <b>Investigate with AI</b>.
          </EmptyState>
        )}
        <ul>
          {list.data?.items.map((i) => (
            <li key={i.id} className="border-t border-white/[0.04] first:border-t-0">
              <Link to={`/investigations/${i.id}`} className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-white/[0.025]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="mono text-[13px] text-slate-200">{i.captureId ?? i.transactionId}</span>
                    <StatusBadge status={STAGE_LABEL[i.stage]?.label ?? i.stage} tone={STAGE_LABEL[i.stage]?.tone} />
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-400">{i.summary ?? 'No report yet'}</p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  {i.confidence !== null && <div className="text-slate-300">{Math.round(i.confidence * 100)}% confidence (estimate)</div>}
                  {dateTime(i.createdAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

export function NewInvestigationPage() {
  const [params] = useSearchParams();
  const target = params.get('target') ?? '';
  const nav = useNavigate();
  const [complaint, setComplaint] = useState('');
  const [captureId, setCaptureId] = useState<string>('');
  const details = useQuery({ queryKey: ['tx-details', target], queryFn: () => api<TransactionDetails>(`/api/transactions/${encodeURIComponent(target)}/details`), enabled: !!target });
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/investigations', { method: 'POST', body: JSON.stringify({ targetId: target, captureId: captureId || null, complaint }) }),
    onSuccess: (r) => nav(`/investigations/${r.id}`),
  });
  // Declined/failed capture attempts are shown in the evidence but are never refund targets.
  const captures = (details.data?.captures ?? []).filter((c) => ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING'].includes(c.status ?? ''));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  if (!target)
    return (
      <Card>
        <EmptyState icon={FileSearch} title="Pick a transaction first" action={<Link to="/transactions"><Button>Go to Transactions</Button></Link>} />
      </Card>
    );

  return (
    <>
      <PageHeader title="New investigation" subtitle={<span>Target <span className="mono text-slate-200">{target}</span></span>} />
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Customer complaint" subtitle="Treated as an unverified allegation. It is data for the investigator, never instructions.">
          <label htmlFor="complaint" className="sr-only">
            Complaint
          </label>
          <textarea
            id="complaint"
            value={complaint}
            onChange={(e) => setComplaint(e.target.value)}
            rows={6}
            maxLength={4000}
            required
            placeholder="e.g. “I was charged but never got a confirmation email. Please refund me.”"
            className="w-full rounded-lg border border-white/10 bg-ink-900 p-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-electric/50 focus:outline-none"
          />
          <div className="mt-1 text-right text-xs text-slate-500">{complaint.length}/4000</div>
          {captures.length > 1 && (
            <div className="mt-4">
              <label htmlFor="capture" className="text-xs font-medium text-slate-400">
                Which capture?
              </label>
              <select id="capture" value={captureId} onChange={(e) => setCaptureId(e.target.value)} required className="mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-sm text-slate-200">
                <option value="">Select a capture…</option>
                {captures.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {money(c.amount)} · {c.status}
                  </option>
                ))}
              </select>
            </div>
          )}
          {create.error && (
            <div className="mt-4">
              <ErrorState title="Could not start the investigation" error={create.error} />
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={create.isPending || complaint.trim().length < 3}>
              <FileSearch className="h-4 w-4" /> {create.isPending ? 'Starting…' : 'Start investigation'}
            </Button>
          </div>
        </Card>
        <Card title="What happens next">
          <ol className="list-decimal space-y-2 pl-4 text-sm text-slate-300">
            <li>The backend collects live PayPal evidence: order, captures, refunds, disputes and verified events.</li>
            <li>Code computes the FactSheet: captured, refunded, remaining refundable and blockers.</li>
            <li>The AI investigator explains what happened. Every claim must cite evidence, and code removes uncited claims.</li>
            <li>Nothing is refunded. Refunds need the Decision Council and your explicit approval.</li>
          </ol>
          {details.data && (
            <div className="mt-4">
              <Notice tone="info" title={`${money(details.data.order?.amount ?? details.data.transaction?.amount)} · ${details.data.order?.status ?? details.data.transaction?.status ?? ''}`}>
                {captures.length} capture(s) that took money{details.data.captures.length > captures.length ? ` (+${details.data.captures.length - captures.length} declined attempt(s))` : ''}, {details.data.refunds.length} refund(s), {details.data.disputes.length} dispute(s)
              </Notice>
            </div>
          )}
        </Card>
      </form>
    </>
  );
}
