import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { FileSearch, Info, Scale, Sparkles } from 'lucide-react';
import { api, type Dispute, type DisputeDetail, type DisputeSummaryResult } from '../lib/api';
import { dateTime, humanize, money } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Button, Card, Drawer, EmptyState, ErrorState, Field, Notice, Pill, Skeleton, StatusBadge } from '../components/ui';

export function DisputesPage() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const list = useQuery({ queryKey: ['disputes'], queryFn: () => api<{ items: Dispute[]; path: string }>('/api/disputes') });
  return (
    <>
      <PageHeader title="Disputes" subtitle="Live from PayPal (list_disputes / get_dispute). Accepting a claim always goes through the Decision Council and your confirmation." />
      <div className="mb-6">
        <Notice tone="info" icon={Info} title="What Refund Detective can and cannot do with disputes">
          It can read disputes, summarise them with cited fields, and (after a council APPROVE and your explicit confirmation) accept a buyer's claim. It cannot submit evidence to PayPal; the MCP server has no tool for that.
        </Notice>
      </div>
      {list.error && <ErrorState title="Could not load disputes" error={list.error} onRetry={() => list.refetch()} />}
      <Card padded={false}>
        {list.isLoading && (
          <div className="space-y-3 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {list.data && list.data.items.length === 0 && (
          <EmptyState icon={Scale} title="No disputes in this Sandbox account">
            PayPal returned zero disputes. A Sandbox buyer can open one from the buyer account's Resolution Center.
          </EmptyState>
        )}
        <ul>
          {list.data?.items.map((d) => (
            <li key={d.id} className="border-t border-white/[0.04] first:border-t-0">
              <button type="button" onClick={() => setParams({ open: d.id })} className="flex w-full flex-wrap items-center gap-4 px-5 py-4 text-left hover:bg-white/[0.025]">
                <span className="mono text-[13px] text-slate-200">{d.id}</span>
                <StatusBadge status={d.status} />
                <span className="text-sm text-slate-400">{humanize(d.reason)}</span>
                <span className="ml-auto text-sm tabular-nums text-slate-200">{money(d.amount)}</span>
                <span className="text-xs text-slate-500">{dateTime(d.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <DisputeDrawer id={openId} onClose={() => setParams({})} />
    </>
  );
}

function DisputeDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useQuery({ queryKey: ['dispute', id], queryFn: () => api<DisputeDetail>(`/api/disputes/${encodeURIComponent(id!)}`), enabled: !!id });
  const summary = useMutation({ mutationFn: () => api<DisputeSummaryResult>(`/api/disputes/${encodeURIComponent(id!)}/summary`, { method: 'POST', body: '{}' }) });
  const d = detail.data?.dispute;
  const capture = d?.disputedTransactionIds[0];
  return (
    <Drawer open={!!id} onClose={onClose} title={<span className="mono">{id}</span>}>
      {detail.isLoading && <Skeleton className="h-40" />}
      {detail.error && <ErrorState error={detail.error} />}
      {d && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            <Pill tone="neutral">{humanize(d.stage)}</Pill>
            <span className="text-lg font-semibold tabular-nums text-white">{money(d.amount)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Reason">{humanize(d.reason)}</Field>
            <Field label="Outcome">{d.outcome ?? 'Not available'}</Field>
            <Field label="Opened">{dateTime(d.createdAt)}</Field>
            <Field label="Updated">{dateTime(d.updatedAt)}</Field>
            <Field label="Disputed capture" mono>{capture ?? 'Not available'}</Field>
            <Field label="Served via">{detail.data?.path === 'mcp' ? 'MCP' : 'REST fallback'}</Field>
          </dl>

          <Card title="AI summary" subtitle="Every key fact cites a field of the PayPal dispute payload" actions={<Button variant="outline" onClick={() => summary.mutate()} disabled={summary.isPending}><Sparkles className="h-4 w-4" /> {summary.isPending ? 'Summarising…' : 'Summarise'}</Button>}>
            {summary.error && <ErrorState error={summary.error} />}
            {!summary.data && !summary.error && <p className="text-sm text-slate-500">Generate a cited summary of this dispute.</p>}
            {summary.data && (
              <div className="space-y-3 text-sm">
                <p className="text-slate-200">{summary.data.summary}</p>
                <p className="text-slate-400">
                  <b className="text-slate-300">Buyer claim (allegation):</b> {summary.data.buyerClaim}
                </p>
                <ul className="space-y-1.5">
                  {summary.data.keyFacts.map((f, i) => (
                    <li key={i} className="text-slate-300">
                      {f.fact}{' '}
                      {f.validFields.map((x) => (
                        <span key={x} className="mono ml-1 rounded bg-violet/10 px-1 py-0.5 text-[10px] text-violet-200">
                          {x}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
                {summary.data.removedUncited > 0 && <p className="text-xs text-slate-500">{summary.data.removedUncited} uncited fact(s) removed by code.</p>}
              </div>
            )}
          </Card>

          {detail.data?.open && capture && (
            <Card title="Resolve">
              <p className="text-sm text-slate-300">To accept the buyer's claim, investigate the disputed capture, then convene the Decision Council on accepting the claim.</p>
              <Link to={`/investigations/new?target=${encodeURIComponent(capture)}`}>
                <Button className="mt-3 w-full">
                  <FileSearch className="h-4 w-4" /> Investigate disputed capture
                </Button>
              </Link>
            </Card>
          )}
          {detail.data && detail.data.actions.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Actions taken</h3>
              {detail.data.actions.map((a) => (
                <div key={a.id} className="rounded-lg border border-white/[0.05] p-3 text-sm text-slate-300">
                  <StatusBadge status={a.status.toUpperCase()} /> {a.paypal_response_summary}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
