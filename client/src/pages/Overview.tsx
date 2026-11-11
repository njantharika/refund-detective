import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CheckCircle2, Clock, FileSearch, ListOrdered, RefreshCw, RotateCcw, Scale, Sparkles, XCircle } from 'lucide-react';
import { api, qs, type DashboardSummary, type IntegrationStatus } from '../lib/api';
import { dateTime, moneyMap, relative } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { SourceBanner } from '../components/SourceBanner';
import { Button, Card, EmptyState, ErrorState, KpiTile, Skeleton } from '../components/ui';

// Validated (dataviz validator, dark surface #111827): violet + teal-600.
const SERIES_ACTIVITY = '#7C5CFF';
const SERIES_REFUND = '#0D9488';

export const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

export function rangeParams(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function ChartTooltip({ active, payload, label, unit }: { active?: boolean; payload?: { value: number }[]; label?: string; unit: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs shadow-xl">
      <div className="text-slate-400">{label}</div>
      <div className="mt-0.5 font-medium text-slate-100 tabular-nums">
        {payload[0].value} {unit}
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [days, setDays] = useState(30);
  const params = useMemo(() => rangeParams(days), [days]);
  const summary = useQuery({ queryKey: ['dashboard', days], queryFn: () => api<DashboardSummary>(`/api/dashboard/summary${qs(params)}`) });
  const status = useQuery({ queryKey: ['integration-status'], queryFn: () => api<IntegrationStatus>('/api/settings/integration-status') });
  const d = summary.data;
  const k = d?.kpis;
  const loading = summary.isLoading;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Live PayPal Sandbox payment activity, refunds and investigations."
        actions={
          <>
            <label className="sr-only" htmlFor="range">
              Date range
            </label>
            <select id="range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200">
              {RANGES.map((r) => (
                <option key={r.days} value={r.days}>
                  {r.label}
                </option>
              ))}
            </select>
            <Button variant="outline" onClick={() => summary.refetch()} aria-label="Refresh dashboard">
              <RefreshCw className={summary.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
          </>
        }
      />

      {summary.error && <ErrorState title="Could not load the dashboard" error={summary.error} onRetry={() => summary.refetch()} />}
      <SourceBanner sources={d?.sources} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile label="Total payments" value={k?.total ?? 0} icon={ListOrdered} loading={loading} hint={d ? moneyMap(k?.capturedVolume) + ' captured' : undefined} />
        <KpiTile label="Successful" value={k?.successful ?? 0} icon={CheckCircle2} loading={loading} />
        <KpiTile label="Failed" value={k?.failed ?? 0} icon={XCircle} loading={loading} />
        <KpiTile label="Pending" value={k?.pending ?? 0} icon={Clock} loading={loading} />
        <KpiTile label="Refunds" value={k?.refunds.count ?? 0} icon={RotateCcw} loading={loading} hint={d ? moneyMap(k?.refunds.amount) : undefined} />
        <KpiTile label="Open investigations" value={k?.openInvestigations ?? 0} icon={FileSearch} loading={loading} />
        <KpiTile label="Open disputes" value={k?.openDisputes ?? '—'} icon={Scale} loading={loading} hint={d?.sources.disputesError ? 'Dispute lookup failed' : undefined} />
        <KpiTile label="Data source" value={<span className="text-base">{d?.dataMode === 'live' ? 'PayPal Sandbox' : 'No data yet'}</span>} loading={loading} hint={d ? `Fetched ${relative(d.fetchedAt)}` : undefined} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Payment activity" subtitle="Payments per day in the selected range">
          {loading ? (
            <Skeleton className="h-56 w-full" />
          ) : k && k.activity.length ? (
            <div className="h-56" role="img" aria-label={`Payment activity: ${k.activity.map((a) => `${a.date} ${a.count}`).join(', ')}`}>
              <ResponsiveContainer>
                <AreaChart data={k.activity} margin={{ left: -16, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="actFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES_ACTIVITY} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={SERIES_ACTIVITY} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgb(148 163 184 / 0.08)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip unit="payments" />} cursor={{ stroke: 'rgb(148 163 184 / 0.3)' }} />
                  <Area type="monotone" dataKey="count" stroke={SERIES_ACTIVITY} strokeWidth={2} fill="url(#actFill)" dot={{ r: 4, fill: SERIES_ACTIVITY, stroke: '#111827', strokeWidth: 2 }} activeDot={{ r: 5 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState icon={ListOrdered} title="No payments in this range">
              Nothing came back from PayPal for this period. See the banner above for data-source status.
            </EmptyState>
          )}
        </Card>

        <Card title="AI insight" subtitle="Generated from the metrics on this page">
          {status.data && !status.data.ai.configured ? (
            <EmptyState icon={Sparkles} title="AI not configured">
              Set <code className="mono">ANTHROPIC_API_KEY</code> in <code className="mono">.env</code> to enable investigator, council and insight summaries.
            </EmptyState>
          ) : (
            <EmptyState icon={Sparkles} title="Insight summaries arrive with the Insights page">
              Metric-cited summaries are generated on the Insights page.
            </EmptyState>
          )}
        </Card>

        <Card title="Refund trend" subtitle="Refunds per day (PayPal-reported)">
          {loading ? (
            <Skeleton className="h-44 w-full" />
          ) : k && k.refundTrend.length ? (
            <div className="h-44" role="img" aria-label={`Refund trend: ${k.refundTrend.map((a) => `${a.date} ${a.count}`).join(', ')}`}>
              <ResponsiveContainer>
                <BarChart data={k.refundTrend} margin={{ left: -16, right: 8, top: 8 }}>
                  <CartesianGrid stroke="rgb(148 163 184 / 0.08)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip unit="refunds" />} cursor={{ fill: 'rgb(148 163 184 / 0.06)' }} />
                  <Bar dataKey="count" fill={SERIES_REFUND} radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState icon={RotateCcw} title="No refunds yet" />
          )}
        </Card>

        <Card title="Investigation pipeline">
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <ul className="space-y-3">
              {(['open', 'awaiting_approval', 'resolved', 'closed'] as const).map((s) => {
                const n = d?.investigationPipeline[s] ?? 0;
                const total = Math.max(1, Object.values(d?.investigationPipeline ?? {}).reduce((a, b) => a + b, 0));
                return (
                  <li key={s}>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300">{s.replace('_', ' ')}</span>
                      <span className="tabular-nums text-slate-400">{n}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-white/[0.05]">
                      <div className="h-1.5 rounded-full bg-electric" style={{ width: `${(n / total) * 100}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Recent activity" subtitle="From the audit log">
          {d && d.recentActivity.length ? (
            <ul className="space-y-2.5">
              {d.recentActivity.map((a, i) => (
                <li key={i} className="flex items-start justify-between gap-3 text-xs">
                  <span className="text-slate-300">
                    <span className="mono text-violet-300">{a.actor}</span> {a.action.replace(/_/g, ' ')}
                  </span>
                  <span className="shrink-0 text-slate-500" title={dateTime(a.created_at)}>
                    {relative(a.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={FileSearch} title="No activity yet">
              <Link className="text-blue-300 underline-offset-2 hover:underline" to="/transactions">
                Open a transaction
              </Link>{' '}
              to start an investigation.
            </EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
