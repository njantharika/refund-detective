import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, FileSearch, ListOrdered, RefreshCw, Search } from 'lucide-react';
import { api, qs, type TransactionDetails, type TransactionList } from '../lib/api';
import { dateTime, money, NA } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { SourceBanner } from '../components/SourceBanner';
import { Button, Card, Drawer, EmptyState, ErrorState, Field, Notice, Pill, Skeleton, StatusBadge } from '../components/ui';
import { RANGES, rangeParams } from './Overview';

type Sort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';

export function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState('');
  const [currency, setCurrency] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [sort, setSort] = useState<Sort>('date_desc');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const openId = params.get('open');
  const range = useMemo(() => rangeParams(days), [days, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setPage(1), [days, status, currency, q, sort]);

  const list = useQuery({
    queryKey: ['transactions', range, status, currency, q, sort, page, refresh],
    queryFn: () => api<TransactionList>(`/api/transactions${qs({ ...range, status, currency, q, sort, page, refresh: refresh ? 'true' : undefined })}`),
    placeholderData: keepPreviousData,
  });

  const open = (id: string) => setParams((p) => (p.set('open', id), p));
  const close = () => setParams((p) => (p.delete('open'), p));
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const sortHeader = (label: string, key: 'date' | 'amount') => {
    const active = sort.startsWith(key);
    const desc = sort.endsWith('desc');
    return (
      <button type="button" className="inline-flex items-center gap-1 hover:text-slate-200" onClick={() => setSort(active && desc ? (`${key}_asc` as Sort) : (`${key}_desc` as Sort))} aria-label={`Sort by ${label}`}>
        {label}
        {active && (desc ? <ArrowDown aria-hidden className="h-3 w-3" /> : <ArrowUp aria-hidden className="h-3 w-3" />)}
      </button>
    );
  };

  return (
    <>
      <PageHeader title="Transactions" subtitle="PayPal Sandbox transactions and orders. Select one to see its full evidence trail." />
      <SourceBanner sources={data?.sources} />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.05] p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transaction, capture or order ID" aria-label="Search transactions" className="mono w-full rounded-lg border border-white/[0.07] bg-ink-900 py-1.5 pl-9 pr-3 text-[13px] text-slate-200 placeholder:font-sans placeholder:text-slate-500 focus:border-electric/50 focus:outline-none" />
          </div>
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200">
            <option value="">All statuses</option>
            {data?.facets.statuses.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <select aria-label="Filter by currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200">
            <option value="">All currencies</option>
            {data?.facets.currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select aria-label="Date range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200">
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={() => setRefresh((n) => n + 1)} aria-label="Refresh from PayPal">
            <RefreshCw className={list.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Refresh
          </Button>
        </div>

        {list.error ? (
          <div className="p-4">
            <ErrorState title="Could not load transactions" error={list.error} onRetry={() => list.refetch()} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">{sortHeader('Date', 'date')}</th>
                  <th className="px-4 py-3 font-medium">Transaction / capture</th>
                  <th className="px-4 py-3 font-medium">Order</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">{sortHeader('Amount', 'amount')}</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading &&
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-t border-white/[0.04]">
                      {Array.from({ length: 6 }).map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <Skeleton />
                        </td>
                      ))}
                    </tr>
                  ))}
                {data?.items.map((t, i) => {
                  const id = t.captureId ?? t.orderId ?? t.transactionId;
                  return (
                    <tr
                      key={`${id}-${i}`}
                      tabIndex={0}
                      onClick={() => id && open(id)}
                      onKeyDown={(e) => e.key === 'Enter' && id && open(id)}
                      className="cursor-pointer border-t border-white/[0.04] hover:bg-white/[0.025] focus:bg-white/[0.04] focus:outline-none"
                      aria-label={`Open transaction ${id}`}
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">{dateTime(t.initiatedAt)}</td>
                      <td className="mono px-4 py-3 text-[13px] text-slate-200">{t.transactionId ?? <span className="font-sans text-slate-500">{NA}</span>}</td>
                      <td className="mono px-4 py-3 text-[13px] text-slate-400">{t.orderId ?? <span className="font-sans text-slate-500">{NA}</span>}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-100">{money(t.amount)}</td>
                      <td className="px-4 py-3">
                        <Pill tone={t.source === 'transaction_search' ? 'info' : t.source === 'demo_sample' ? 'warning' : 'violet'}>{t.source === 'transaction_search' ? 'Transaction Search' : t.source === 'demo_sample' ? 'Sample (Demo mode)' : 'Live order'}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data && data.items.length === 0 && (
              <EmptyState icon={ListOrdered} title={q || status || currency ? 'No transactions match these filters' : 'No PayPal transactions in this range'}>
                {q || status || currency ? 'Try clearing a filter.' : 'Check the data-source notice above.'}
              </EmptyState>
            )}
          </div>
        )}

        {data && data.total > 0 && (
          <div className="flex items-center justify-between border-t border-white/[0.05] px-4 py-3 text-xs text-slate-400">
            <span>
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 tabular-nums">
                {page} / {pages}
              </span>
              <Button variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <TransactionDrawer id={openId} onClose={close} />
    </>
  );
}

export function TransactionDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const details = useQuery({ queryKey: ['tx-details', id], queryFn: () => api<TransactionDetails>(`/api/transactions/${encodeURIComponent(id!)}/details`), enabled: !!id });
  const d = details.data;
  const order = d?.order;

  return (
    <Drawer open={!!id} onClose={onClose} title={<span className="mono">{id}</span>}>
      {details.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {details.error && <ErrorState title="Could not load this transaction" error={details.error} onRetry={() => details.refetch()} />}
      {d && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={order?.status ?? d.transaction?.status} />
            <span className="text-lg font-semibold text-white tabular-nums">{money(order?.amount ?? d.transaction?.amount)}</span>
          </div>
          <Button onClick={() => nav(`/investigations/new?target=${encodeURIComponent(id!)}`)} className="w-full py-2" disabled={id?.startsWith('DEMO-')} title={id?.startsWith('DEMO-') ? 'Disabled in Demo mode' : undefined}>
            <FileSearch className="h-4 w-4" /> Investigate with AI
          </Button>

          {d.errors.length > 0 && (
            <Notice title="Some PayPal sections could not be loaded">
              {d.errors.map((e, i) => (
                <div key={i}>
                  <b>{e.section}</b>: {e.message}
                </div>
              ))}
            </Notice>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Summary</h3>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Order ID" mono>{order?.id ?? NA}</Field>
              <Field label="Intent">{order?.intent ?? NA}</Field>
              <Field label="Created">{dateTime(order?.createdAt ?? d.transaction?.initiatedAt)}</Field>
              <Field label="Updated">{dateTime(order?.updatedAt ?? d.transaction?.updatedAt)}</Field>
              <Field label="Description">{order?.description ?? d.transaction?.note ?? NA}</Field>
              <Field label="Event code" mono>{d.transaction?.eventCode ?? NA}</Field>
            </dl>
          </section>

          <Section title={`Captures (${d.captures.length})`} empty="No captures on this order.">
            {d.captures.map((c) => (
              <Row key={c.id} id={c.id} status={c.status} right={money(c.amount)} sub={dateTime(c.createdAt)} />
            ))}
          </Section>
          <Section title={`Refunds (${d.refunds.length})`} empty="No refunds reported by PayPal.">
            {d.refunds.map((r) => (
              <Row key={r.id} id={r.id} status={r.status} right={money(r.amount)} sub={dateTime(r.createdAt)} />
            ))}
          </Section>
          <Section title={`Disputes (${d.disputes.length})`} empty="No disputes on these captures.">
            {d.disputes.map((x) => (
              <Row key={x.id} id={x.id} status={x.status} right={money(x.amount)} sub={x.reason ?? undefined} />
            ))}
          </Section>
          <Section title={`Verified events (${d.events.length})`} empty="No webhook events linked to this payment.">
            {d.events.map((e) => (
              <Row key={e.id} id={e.event_type} status={e.signature_verified ? 'VERIFIED' : 'UNVERIFIED'} sub={dateTime(e.event_time)} />
            ))}
          </Section>
          <Section title={`Investigations (${d.investigations.length})`} empty="Not investigated yet.">
            {d.investigations.map((i) => (
              <button key={i.id} type="button" onClick={() => nav(`/investigations/${i.id}`)} className="block w-full text-left">
                <Row id={i.id} status={i.status} sub={i.summary ?? undefined} />
              </button>
            ))}
          </Section>
        </div>
      )}
    </Drawer>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const has = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      {has ? <div className="space-y-2">{children}</div> : <p className="text-sm text-slate-500">{empty}</p>}
    </section>
  );
}

function Row({ id, status, right, sub }: { id: string; status: string | null; right?: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.05] bg-ink-850 px-3 py-2.5">
      <div className="min-w-0">
        <div className="mono truncate text-[13px] text-slate-200">{id}</div>
        {sub && <div className="truncate text-xs text-slate-500">{sub}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {right && <span className="text-sm tabular-nums text-slate-200">{right}</span>}
        <StatusBadge status={status} />
      </div>
    </div>
  );
}
