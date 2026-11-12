import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Gavel, LineChart, RefreshCw, Scale, ShieldAlert, Sparkles } from 'lucide-react';
import { api, qs, type InsightSummary, type Insights } from '../lib/api';
import { moneyMap, relative } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { SourceBanner } from '../components/SourceBanner';
import { Button, Card, EmptyState, ErrorState, KpiTile, Skeleton } from '../components/ui';
import { VERDICT_META } from '../components/CouncilPanel';
import { RANGES, rangeParams } from './Overview';

// Single-series bars use the validated violet (dataviz validator, dark surface #111827).
const BAR = '#7C5CFF';

function Distribution({ data, label }: { data: Record<string, number>; label: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  if (!entries.length) return <p className="text-sm text-slate-500">No data.</p>;
  return (
    <ul className="space-y-2.5" aria-label={label}>
      {entries.map(([k, n]) => (
        <li key={k}>
          <div className="flex justify-between text-xs">
            <span className="text-slate-300">{k.replace(/_/g, ' ')}</span>
            <span className="tabular-nums text-slate-400">{n}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-white/[0.05]">
            <div className="h-1.5 rounded-full" style={{ width: `${(n / max) * 100}%`, background: BAR }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function InsightsPage() {
  const [days, setDays] = useState(30);
  const range = useMemo(() => rangeParams(days), [days]);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['insights', days], queryFn: () => api<Insights>(`/api/insights${qs(range)}`) });
  const gen = useMutation({ mutationFn: () => api<InsightSummary>(`/api/insights/summary${qs(range)}`, { method: 'POST', body: '{}' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }) });
  const m = q.data?.metrics;
  const summary = gen.data ?? q.data?.latestSummary ?? null;
  const rate = m ? Object.entries(m.refunds.ratePercentOfCaptured).map(([c, r]) => (r === null ? `${c}: n/a` : `${r}% of ${c}`)).join(' · ') || '0%' : '';

  return (
    <>
      <PageHeader
        title="Insights"
        subtitle="Computed from real Sandbox data and Refund Detective's own records. No savings or impact claims."
        actions={
          <select aria-label="Date range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200">
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        }
      />
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <SourceBanner sources={q.data?.sources} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile label="Captured volume" value={m ? moneyMap(m.capturedVolume) : '—'} loading={q.isLoading} hint={m ? `${m.payments.successful} successful payment(s)` : undefined} />
        <KpiTile label="Refund volume" value={m ? moneyMap(m.refunds.amount) : '—'} loading={q.isLoading} hint={m ? `${m.refunds.count} refund(s) · ${rate}${m.refunds.pendingCount ? ` · ${m.refunds.pendingCount} pending (${moneyMap(m.refunds.pendingAmount)})` : ''}` : undefined} />
        <KpiTile label="Disputes" icon={Scale} value={m?.disputes ? m.disputes.total : '—'} loading={q.isLoading} hint={m?.disputes ? `${m.disputes.open} open` : q.data?.sources.disputesError ? 'Lookup failed' : undefined} />
        <KpiTile label="Guardrail overrides" icon={ShieldAlert} value={m?.council.guardrailOverrides ?? '—'} loading={q.isLoading} hint="Times code made the Judge stricter" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title={
            <span className="flex items-center gap-2">
              <Sparkles aria-hidden className="h-4 w-4 text-violet-300" /> AI insight
            </span>
          }
          subtitle="Every observation cites the metric keys it is based on; uncited observations are removed by code."
          actions={
            <Button variant="outline" onClick={() => gen.mutate()} disabled={gen.isPending || !m}>
              <RefreshCw className={gen.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> {summary ? 'Regenerate' : 'Generate'}
            </Button>
          }
        >
          {gen.error && <ErrorState title="Could not generate the insight" error={gen.error} />}
          {!summary && !gen.error && <EmptyState icon={Sparkles} title="No insight generated yet">Generate a cited summary of these metrics.</EmptyState>}
          {summary && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-slate-100">{summary.headline}</p>
              <ul className="space-y-2">
                {summary.observations.map((o, i) => (
                  <li key={i} className="text-sm text-slate-300">
                    {o.text}
                    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
                      {o.metrics.map((k) => (
                        <span key={k} className="mono rounded bg-violet/10 px-1.5 py-0.5 text-[10px] text-violet-200 ring-1 ring-inset ring-violet/25">
                          {k}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
              {summary.caveats.length > 0 && <ul className="list-disc pl-5 text-xs text-slate-500">{summary.caveats.map((c) => <li key={c}>{c}</li>)}</ul>}
              <p className="text-[11px] text-slate-500">
                {summary.model} · {relative(summary.createdAt)}
                {summary.removedUncited > 0 ? ` · ${summary.removedUncited} uncited observation(s) removed` : ''}
              </p>
            </div>
          )}
        </Card>

        <Card title="Council verdicts" subtitle="Final outcomes after guardrails">
          {q.isLoading ? (
            <Skeleton className="h-24" />
          ) : m && Object.keys(m.council.verdicts).length ? (
            <ul className="space-y-2">
              {Object.entries(m.council.verdicts).map(([v, n]) => {
                const meta = VERDICT_META[v as keyof typeof VERDICT_META];
                const I = meta?.icon ?? Gavel;
                return (
                  <li key={v} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-slate-300">
                      <I aria-hidden className="h-4 w-4 text-slate-400" /> {meta?.label ?? v}
                    </span>
                    <span className="tabular-nums text-slate-200">{n}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={Gavel} title="No councils yet" />
          )}
        </Card>

        <Card title="Payment status mix">{m ? <Distribution data={m.statusDistribution} label="Payment status distribution" /> : <Skeleton className="h-24" />}</Card>

        <Card title="Investigations">
          {m ? (
            <dl className="grid grid-cols-1 gap-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-400">Reports ready</dt>
                <dd className="tabular-nums text-slate-100">{m.investigations.reportsReady}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Avg. root-cause confidence (estimate)</dt>
                <dd className="tabular-nums text-slate-100">{m.investigations.avgRootCauseConfidence === null ? '—' : `${Math.round(m.investigations.avgRootCauseConfidence * 100)}%`}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Uncited claims removed by code</dt>
                <dd className="tabular-nums text-slate-100">{m.investigations.uncitedClaimsRemoved}</dd>
              </div>
            </dl>
          ) : (
            <Skeleton className="h-24" />
          )}
        </Card>

        <Card title="Payments per day">
          {q.data && q.data.series.activity.length ? (
            <div className="h-40" role="img" aria-label={`Payments per day: ${q.data.series.activity.map((a) => `${a.date} ${a.count}`).join(', ')}`}>
              <ResponsiveContainer>
                <BarChart data={q.data.series.activity} margin={{ left: -16, right: 8, top: 8 }}>
                  <CartesianGrid stroke="rgb(148 163 184 / 0.08)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: 'rgb(148 163 184 / 0.06)' }} contentStyle={{ background: '#0f1529', border: '1px solid rgb(255 255 255 / 0.1)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" name="payments" fill={BAR} radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState icon={LineChart} title="No payments in range" />
          )}
        </Card>
      </div>
    </>
  );
}
