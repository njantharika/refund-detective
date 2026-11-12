import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, CircleDashed, Copy, Database, Download, FileText, Gavel, ListTree, Loader2, MessageSquare, RefreshCw, Search, Send, ShieldCheck, User } from 'lucide-react';
import { api, type Deliberation, type Evidence, type Investigation, type RefundRecord } from '../lib/api';
import { dateTime, NA } from '../lib/format';
import { reportMarkdown } from '../lib/report-md';
import { PageHeader } from '../components/Shell';
import { Button, Card, cx, EmptyState, ErrorState, EvidenceChip, Notice, Pill, Skeleton, StatusBadge } from '../components/ui';
import { STAGE_LABEL } from './Investigations';
import { CouncilPanel, useCouncil, VerdictBadge } from '../components/CouncilPanel';
import { RefundModal } from '../components/RefundModal';
import { DisputeAcceptModal } from '../components/DisputeAcceptModal';

const SOURCE_META: Record<Evidence['source'], { label: string; icon: typeof ShieldCheck; tone: 'success' | 'info' | 'warning' | 'neutral' | 'violet' }> = {
  paypal_mcp: { label: 'PayPal · MCP', icon: ShieldCheck, tone: 'success' },
  paypal_rest: { label: 'PayPal · REST', icon: ShieldCheck, tone: 'success' },
  webhook_verified: { label: 'Verified webhook', icon: ShieldCheck, tone: 'success' },
  app_internal: { label: 'App record', icon: Database, tone: 'violet' },
  merchant_input: { label: 'Merchant input · unverified', icon: User, tone: 'warning' },
};

type Tab = 'report' | 'evidence' | 'council';
const TABS: Tab[] = ['report', 'evidence', 'council'];

export function InvestigationWorkspace() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'report';
  const setTab = useCallback((t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'report') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true }), [setParams]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<Tab | null>(null);
  const [reviewing, setReviewing] = useState<Deliberation | null>(null);
  const [reviewingDispute, setReviewingDispute] = useState<Deliberation | null>(null);
  const { latest } = useCouncil(id);
  const inv = useQuery({
    queryKey: ['investigation', id],
    queryFn: () => api<Investigation>(`/api/investigations/${id}`),
    refetchInterval: (q) => (q.state.data && (q.state.data.stage === 'collecting' || q.state.data.stage === 'analyzing') ? 1500 : false),
  });
  const refresh = useMutation({ mutationFn: () => api(`/api/investigations/${id}/refresh-evidence`, { method: 'POST', body: '{}' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['investigation', id] }) });

  // Citing an evidence ID jumps to it in the Evidence tab and remembers where you came from.
  const select = useCallback(
    (evId: string) => {
      setReturnTo((r) => (tab === 'evidence' ? r : tab));
      setTab('evidence');
      setHighlight(evId);
      window.setTimeout(() => setHighlight((h) => (h === evId ? null : h)), 2500);
    },
    [tab, setTab],
  );
  useEffect(() => {
    if (highlight && tab === 'evidence') document.getElementById(`ev-${highlight}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight, tab]);

  const d = inv.data;
  if (inv.isLoading) return <Skeleton className="h-96 w-full" />;
  if (inv.error || !d) return <ErrorState title="Could not load the investigation" error={inv.error ?? 'Not found'} onRetry={() => inv.refetch()} />;
  const busy = d.stage === 'collecting' || d.stage === 'analyzing';
  const valid = new Set(d.evidence.map((e) => e.id));
  const missingCount = d.factSheet?.missingEvidence.length ?? 0;

  return (
    <>
      <PageHeader
        title="Investigation"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="mono text-slate-300">{d.id}</span>
            <StatusBadge status={STAGE_LABEL[d.stage]?.label ?? d.stage} tone={STAGE_LABEL[d.stage]?.tone} />
            {d.model && <Pill tone="violet">{d.model}</Pill>}
          </span>
        }
        actions={
          <>
            <Button variant="outline" disabled={busy || refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className={cx('h-4 w-4', (busy || refresh.isPending) && 'animate-spin')} /> Refresh evidence
            </Button>
            <ExportButtons inv={d} />
          </>
        }
      />

      {busy && (
        <div role="status" aria-live="polite" className="mb-4 flex items-center gap-3 rounded-[12px] border border-electric/25 bg-electric/[0.06] px-4 py-2.5 text-sm text-blue-100">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          {d.stageDetail ?? 'Working…'}
        </div>
      )}
      {d.stage === 'failed' && <div className="mb-4"><ErrorState title="Investigation failed" error={d.error ?? 'Unknown error'} onRetry={() => refresh.mutate()} /></div>}
      {d.stage === 'ai_unavailable' && (
        <div className="mb-4">
          <Notice title="AI not configured">Evidence and the FactSheet were collected, but no AI report was generated. Configure an AI provider in .env and refresh.</Notice>
        </div>
      )}

      <CaseStrip inv={d} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div role="tablist" aria-label="Investigation sections" className="mb-3 flex w-full rounded-lg border sm:inline-flex sm:w-auto border-white/[0.06] bg-ink-900/70 p-0.5">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`panel-${t}`}
                onClick={() => { setReturnTo(null); setTab(t); }}
                className={cx('flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors sm:flex-none', tab === t ? 'bg-white/[0.08] font-medium text-white' : 'text-slate-400 hover:text-slate-200')}
              >
                {t === 'report' && <><FileText aria-hidden className="h-3.5 w-3.5" /> Report{d.report ? <span className="text-xs text-slate-500">{d.report.findings.length}</span> : null}</>}
                {t === 'evidence' && <><ListTree aria-hidden className="h-3.5 w-3.5" /> Evidence <span className="text-xs text-slate-500">{d.evidence.length}{missingCount ? <span className="hidden sm:inline">{` · ${missingCount} missing`}</span> : null}</span></>}
                {t === 'council' && <><Gavel aria-hidden className="h-3.5 w-3.5" /> Council{latest && <VerdictDot v={latest.finalOutcome} />}</>}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'report' && <ReportSection inv={d} valid={valid} onSelect={select} highlight={highlight} busy={busy} />}
            {tab === 'evidence' && (
              <>
                {returnTo && (
                  <button onClick={() => { setTab(returnTo); setReturnTo(null); }} className="mb-2 inline-flex items-center gap-1 text-xs text-blue-300 hover:underline">
                    <ArrowLeft aria-hidden className="h-3.5 w-3.5" /> Back to {returnTo === 'council' ? 'Council' : 'Report'}
                  </button>
                )}
                <Timeline inv={d} highlight={highlight} />
              </>
            )}
            {tab === 'council' && <CouncilPanel inv={d} onSelect={select} onReview={setReviewing} onReviewDispute={setReviewingDispute} />}
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <ResolutionCard inv={d} onReview={setReviewing} onOpenCouncil={() => setTab('council')} />
          <ChatPanel inv={d} valid={valid} onSelect={select} />
        </aside>
      </div>

      <RefundModal inv={d} deliberation={reviewing} onClose={() => setReviewing(null)} />
      <DisputeAcceptModal inv={d} deliberation={reviewingDispute} onClose={() => setReviewingDispute(null)} />
    </>
  );
}

function VerdictDot({ v }: { v: Deliberation['finalOutcome'] }) {
  const tone = !v ? 'bg-slate-500 animate-pulse' : v.startsWith('APPROVE') ? 'bg-teal' : v === 'REJECT' ? 'bg-rose-400' : 'bg-amber-400';
  return <span aria-label={v ? `latest verdict ${v.replace(/_/g, ' ')}` : 'deliberating'} className={cx('h-1.5 w-1.5 rounded-full', tone)} />;
}

/** Small uppercase section label used inside the compact cards. */
function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cx('text-[11px] font-semibold uppercase tracking-wider text-slate-500', className)}>{children}</h3>;
}

function ExportButtons({ inv }: { inv: Investigation }) {
  const [copied, setCopied] = useState(false);
  const md = useMemo(() => reportMarkdown(inv), [inv]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${inv.id}.md` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <Button variant="outline" onClick={copy} aria-label="Copy report as Markdown">
        {copied ? <CheckCircle2 className="h-4 w-4 text-teal" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
      </Button>
      <Button variant="outline" onClick={download} aria-label="Download report as Markdown">
        <Download className="h-4 w-4" /> .md
      </Button>
    </>
  );
}

function Money({ v, c }: { v: string | null; c: string | null }) {
  return <span className="tabular-nums">{v === null ? NA : `${v} ${c ?? ''}`}</span>;
}

function Stat({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={cx('mt-0.5 truncate text-sm', strong ? 'font-semibold text-white' : 'text-slate-200')}>{children}</dd>
    </div>
  );
}

/** One band: what case this is, what the customer claims, and what code computed from PayPal. */
function CaseStrip({ inv }: { inv: Investigation }) {
  const fs = inv.factSheet;
  return (
    <section className="rounded-[12px] border border-white/[0.06] bg-ink-850/80">
      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] md:divide-x md:divide-white/[0.05]">
        <div className="min-w-0 space-y-2.5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div className="min-w-0"><dt className="text-slate-500">Order</dt><dd className="mono truncate text-[12px] text-slate-200">{inv.orderId ?? NA}</dd></div>
            <div className="min-w-0"><dt className="text-slate-500">Capture</dt><dd className="mono truncate text-[12px] text-slate-200">{inv.captureId ?? NA}</dd></div>
          </dl>
          <div>
            <div className="flex items-center gap-2">
              <Label>Complaint</Label>
              <span className="text-[10px] text-amber-300/80">unverified allegation</span>
              <span className="ml-auto text-[11px] text-slate-500">{dateTime(inv.createdAt)}</span>
            </div>
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-slate-300" title={inv.complaint ?? undefined}>
              {inv.complaint ? `“${inv.complaint}”` : <span className="text-slate-500">No complaint entered.</span>}
            </p>
          </div>
        </div>

        <div className="min-w-0 md:pl-4">
          <div className="flex items-center gap-2">
            <Label>FactSheet</Label>
            <span className="flex items-center gap-1 text-[10px] text-slate-500" title="Computed by code from PayPal data. The AI cannot override it; councils and refunds always recompute it live.">
              <ShieldCheck aria-hidden className="h-3 w-3 text-teal" /> computed by code{fs ? ` · ${dateTime(fs.computedAt)}` : ''}
            </span>
          </div>
          {!fs ? (
            <Skeleton className="mt-2 h-10" />
          ) : (
            <>
              <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
                <Stat label="Status">{fs.captureStatus ?? NA}</Stat>
                <Stat label="Captured"><Money v={fs.capturedAmount} c={fs.currency} /></Stat>
                <Stat label="Refunded"><Money v={fs.completedRefundTotal} c={fs.currency} /></Stat>
                <Stat label="Pending"><Money v={fs.pendingRefundTotal} c={fs.currency} /></Stat>
                <Stat label="Remaining" strong><Money v={fs.remainingRefundable} c={fs.currency} /></Stat>
                <Stat label="Disputes">{fs.openDisputes.length ? <span className="text-amber-200">{fs.openDisputes.join(', ')}</span> : 'None'}</Stat>
              </dl>
              {fs.refunds.length > 0 && (
                <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
                  {fs.refunds.map((r) => (
                    <li key={r.id} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <span className="mono">{r.id}</span>
                      <span className="tabular-nums text-slate-300">{r.amount} {r.currency}</span>
                      <StatusBadge status={r.status} />
                      {r.initiatedBy && <Pill tone={r.initiatedBy === 'refund_detective' ? 'violet' : 'neutral'}>{r.initiatedBy === 'refund_detective' ? 'via Refund Detective' : 'outside this app'}</Pill>}
                    </li>
                  ))}
                </ul>
              )}
              {fs.notes && fs.notes.length > 0 && <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-500">{fs.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              {fs.conflictingStatuses.length > 0 && (
                <div className="mt-2.5">
                  <Notice tone="danger" title="Conflicting statuses">
                    <ul className="list-disc pl-4">{fs.conflictingStatuses.map((c) => <li key={c}>{c}</li>)}</ul>
                  </Notice>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ReportSection({ inv, valid, onSelect, highlight, busy }: { inv: Investigation; valid: Set<string>; onSelect: (id: string) => void; highlight: string | null; busy: boolean }) {
  const r = inv.report;
  const verified = new Map(inv.evidence.map((e) => [e.id, e.verified]));
  if (!r) {
    return (
      <Card>
        {busy ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : (
          <EmptyState icon={Search} title="No AI report">
            {inv.stage === 'ai_unavailable' ? 'AI not configured.' : 'The investigator did not produce a report.'}
          </EmptyState>
        )}
      </Card>
    );
  }
  const chips = (ids: string[]) => ids.map((x) => <EvidenceChip key={x} id={x} onSelect={onSelect} invalid={!valid.has(x)} active={highlight === x} />);
  const removed = inv.citationAudit?.removedFindings ?? [];
  const rc = r.likelyRootCause;
  return (
    <section className="divide-y divide-white/[0.05] rounded-[12px] border border-white/[0.06] bg-ink-850/80">
      <div className="p-4">
        <div className="flex items-center gap-2">
          <Label>Case summary</Label>
          <span className="text-[11px] text-slate-500">transaction {r.transactionStatus}</span>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-200">{r.caseSummary}</p>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2">
          <Label>Findings ({r.findings.length})</Label>
          <span className="text-[11px] text-slate-500">every finding cites evidence</span>
        </div>
        <ul className="mt-2 divide-y divide-white/[0.04]">
          {r.findings.map((f, i) => {
            const allegationOnly = f.evidenceIds.every((x) => verified.get(x) === false);
            return (
              <li key={i} className="py-2.5 first:pt-1 last:pb-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', f.severity === 'high' ? 'bg-rose-400' : f.severity === 'medium' ? 'bg-amber-400' : 'bg-slate-500')} title={`${f.severity} severity`} />
                  <span className="text-sm font-medium text-slate-100">{f.title}</span>
                  <Pill tone={f.kind === 'observed' ? 'success' : 'info'}>{f.kind}</Pill>
                  <Pill tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warning' : 'neutral'}>{f.severity}</Pill>
                  {allegationOnly && <Pill tone="warning" icon={AlertTriangle}>allegation only</Pill>}
                  <span className="ml-auto flex flex-wrap gap-1">{chips(f.evidenceIds)}</span>
                </div>
                <p className="mt-1 pl-3 text-[13px] leading-relaxed text-slate-400">{f.explanation}</p>
              </li>
            );
          })}
        </ul>
        {removed.length > 0 && (
          <details className="mt-3 rounded-lg border border-dashed border-white/10 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-slate-400">{removed.length} uncited claim(s) removed by code</summary>
            <ul className="mt-1 space-y-1">
              {removed.map((x, i) => (
                <li key={i} className="text-xs text-slate-500">
                  <span className="line-through">{x.title}</span> · {x.reason === 'uncited' ? 'no citation' : `cited nonexistent ${x.invalidIds.join(', ')}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="grid md:grid-cols-2 md:divide-x md:divide-white/[0.05]">
        <div className="p-4">
          <Label>Likely root cause</Label>
          <p className="mt-1.5 text-sm text-slate-200">{rc.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <ConfidenceMeter value={rc.confidence} />
            <div className="flex flex-wrap gap-1">{chips(rc.supportingEvidenceIds)}</div>
          </div>
          {rc.limitations.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-slate-500">{rc.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
        </div>
        <div className="space-y-4 p-4">
          {r.alternativeExplanations.length > 0 && (
            <div>
              <Label>Alternative explanations</Label>
              <ul className="mt-1.5 space-y-1.5">
                {r.alternativeExplanations.map((a, i) => (
                  <li key={i} className="text-[13px] text-slate-300">
                    {a.description} <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">{chips(a.evidenceIds)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.missingInformation.length > 0 && (
            <div>
              <Label>Missing information</Label>
              <ul className="mt-1.5 space-y-1">
                {r.missingInformation.map((m) => (
                  <li key={m} className="flex items-start gap-2 text-[13px] text-slate-300">
                    <CircleDashed aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" /> {m}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2" title="Confidence is an estimate, not a statistical guarantee">
      <div className="h-1.5 w-24 rounded-full bg-white/[0.06]" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Confidence estimate">
        <div className="h-1.5 rounded-full bg-violet" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-300 tabular-nums">{pct}%</span>
      <span className="text-[11px] text-slate-500">estimate</span>
    </div>
  );
}

function Timeline({ inv, highlight }: { inv: Investigation; highlight: string | null }) {
  const items = [...inv.evidence].sort((a, b) => (a.observedAt ?? '9').localeCompare(b.observedAt ?? '9'));
  const missing = inv.factSheet?.missingEvidence ?? [];
  return (
    <section className="rounded-[12px] border border-white/[0.06] bg-ink-850/80 p-2">
      <ol className="divide-y divide-white/[0.04]">
        {items.map((e) => {
          const meta = SOURCE_META[e.source];
          const I = meta.icon;
          return (
            <li key={e.id} id={`ev-${e.id}`} className={cx('scroll-mt-24 rounded-lg px-3 py-2 transition-colors', highlight === e.id ? 'bg-electric/[0.12] ring-1 ring-electric/50' : 'hover:bg-white/[0.02]')}>
              <div className="flex items-start gap-3">
                <span aria-hidden className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', e.verified ? 'bg-teal' : e.source === 'merchant_input' ? 'bg-amber-400' : 'bg-violet')} />
                <span className="mono mt-0.5 w-14 shrink-0 text-[12px] text-slate-400">{e.id}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-slate-200">{e.description}</p>
                  {e.type === 'merchant_complaint' && typeof e.normalized.complaint === 'string' && <p className="mt-0.5 text-xs italic text-slate-400">“{e.normalized.complaint}”</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    <Pill tone={meta.tone} icon={I}>{meta.label}</Pill>
                    <span className="sm:hidden">{e.observedAt ? dateTime(e.observedAt) : 'time n/a'}</span>
                    <span>{e.type.replace(/_/g, ' ')}</span>
                    {e.provenance?.tool && <span>via <span className="mono">{e.provenance.tool}</span>{e.provenance.path === 'rest_fallback' ? ' (REST fallback)' : ''}</span>}
                  </div>
                </div>
                <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-slate-500 sm:block">{e.observedAt ? dateTime(e.observedAt) : 'time n/a'}</span>
              </div>
            </li>
          );
        })}
        {missing.map((m) => (
          <li key={m} className="flex items-start gap-3 px-3 py-2">
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-slate-500" />
            <span className="mono mt-0.5 w-14 shrink-0 text-[12px] text-slate-600">—</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-slate-400">{m}</p>
              <div className="mt-1"><Pill tone="neutral" icon={CircleDashed}>Missing</Pill></div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChatPanel({ inv, valid, onSelect }: { inv: Investigation; valid: Set<string>; onSelect: (id: string) => void }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const send = useMutation({
    mutationFn: (message: string) => api(`/api/investigations/${inv.id}/chat`, { method: 'POST', body: JSON.stringify({ message }) }),
    onSuccess: () => {
      setMsg('');
      qc.invalidateQueries({ queryKey: ['investigation', inv.id] });
    },
  });
  const ready = inv.stage === 'ready';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (msg.trim()) send.mutate(msg.trim());
  };
  return (
    <section className="rounded-[12px] border border-white/[0.06] bg-ink-850/80 p-4">
      <div className="flex items-center gap-2">
        <Label>Ask the investigator</Label>
        <span className="text-[10px] text-slate-500">same evidence</span>
      </div>
      {(inv.messages.length > 0 || send.isPending) && (
        <div className="mt-2 max-h-48 space-y-2.5 overflow-y-auto pr-1" aria-live="polite">
          {inv.messages.map((m) => (
            <div key={m.id} className={cx('flex gap-2', m.role === 'merchant' && 'flex-row-reverse')}>
              <div className={cx('mt-0.5 h-fit rounded-full p-1', m.role === 'merchant' ? 'bg-white/[0.06]' : 'bg-violet/15')}>
                {m.role === 'merchant' ? <User aria-hidden className="h-3 w-3 text-slate-300" /> : <Bot aria-hidden className="h-3 w-3 text-violet-300" />}
              </div>
              <div className={cx('max-w-[85%] rounded-lg px-2.5 py-1.5 text-[13px]', m.role === 'merchant' ? 'bg-white/[0.05] text-slate-200' : 'bg-ink-900 text-slate-200 ring-1 ring-white/[0.05]')}>
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.role === 'investigator' && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {m.kind && <Pill tone={m.kind === 'observed' ? 'success' : m.kind === 'inferred' ? 'info' : 'neutral'}>{m.kind}</Pill>}
                    {m.evidenceIds.map((x) => <EvidenceChip key={x} id={x} onSelect={onSelect} invalid={!valid.has(x)} />)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {send.isPending && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Investigator is answering…
            </div>
          )}
        </div>
      )}
      {send.error && <div className="mt-2"><ErrorState title="Question failed" error={send.error} /></div>}
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <label htmlFor="chat" className="sr-only">Ask a follow-up question</label>
        <input id="chat" value={msg} onChange={(e) => setMsg(e.target.value)} disabled={!ready || send.isPending} maxLength={2000} placeholder={ready ? 'e.g. Was the payment captured?' : 'Waiting for report…'} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-electric/50 focus:outline-none disabled:opacity-50" />
        <Button type="submit" disabled={!ready || send.isPending || !msg.trim()} aria-label="Send question">
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
    </section>
  );
}

function ResolutionCard({ inv, onReview, onOpenCouncil }: { inv: Investigation; onReview: (d: Deliberation) => void; onOpenCouncil: () => void }) {
  const fs = inv.factSheet;
  const p = inv.report?.proposedDecision;
  const { latest } = useCouncil(inv.id);
  const refunds = useQuery({ queryKey: ['refunds', inv.id], queryFn: () => api<{ items: RefundRecord[] }>(`/api/investigations/${inv.id}/refunds`), refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'unknown' || r.status === 'requested') ? 4000 : false) });
  const executable = latest?.decisionType === 'refund' && latest.executable && (latest.finalOutcome === 'APPROVE' || latest.finalOutcome === 'APPROVE_MODIFIED') && !refunds.data?.items.some((r) => r.deliberationId === latest.id);
  return (
    <section className="rounded-[12px] border border-white/[0.06] bg-ink-850/80 p-4">
      <div className="flex items-center gap-2">
        <Label>Resolution</Label>
        <span className="text-[10px] text-slate-500" title="Eligibility is deterministic and recomputed live before any refund.">recomputed live before any refund</span>
      </div>
      {!fs ? (
        <Skeleton className="mt-2 h-12" />
      ) : (
        <div className="mt-2">
          <div className="flex items-start gap-2">
            {fs.refundEligible ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-teal" /> : <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />}
            <span className="text-sm font-medium text-slate-100">{fs.refundEligible ? `Eligible at investigation time · up to ${fs.remainingRefundable} ${fs.currency}` : 'Not eligible at investigation time'}</span>
          </div>
          {fs.refundBlockers.length > 0 && <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-xs text-slate-300">{fs.refundBlockers.map((b) => <li key={b}>{b}</li>)}</ul>}
          {refunds.data && refunds.data.items.some((r) => r.status === 'completed' || r.status === 'pending') && <p className="mt-1.5 text-[11px] text-amber-200/90">Refunds were executed after this snapshot. The council and the approval step recompute eligibility live.</p>}
        </div>
      )}
      {p && (
        <div className="mt-3 rounded-lg bg-ink-900/60 px-3 py-2 ring-1 ring-inset ring-white/[0.05]">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <MessageSquare aria-hidden className="h-3 w-3" /> Investigator's proposal (recommendation only)
          </div>
          <div className="mt-0.5 text-sm text-slate-100">
            <span className="font-medium">{p.type.replace(/_/g, ' ')}</span>
            {p.amount && <span className="tabular-nums"> · {p.amount} {p.currency}</span>}
          </div>
          <p className="mt-0.5 line-clamp-3 text-xs text-slate-400" title={p.reason}>{p.reason}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-300">
        {latest ? (
          <>
            Latest council: <VerdictBadge v={latest.finalOutcome} /> {!latest.finalOutcome && <span className="text-xs text-slate-500">deliberating…</span>}
          </>
        ) : (
          <span className="text-xs text-slate-500">No council yet.</span>
        )}
        <button onClick={onOpenCouncil} className="ml-auto text-xs text-blue-300 hover:underline">{latest ? 'Open council' : 'Convene council'} →</button>
      </div>
      <Button className="mt-3 w-full" disabled={!executable} onClick={() => latest && onReview(latest)}>
        <Gavel className="h-4 w-4" /> Review &amp; approve refund{executable && latest?.executable ? ` · ${latest.executable.currency} ${latest.executable.amount}` : ''}
      </Button>
      <p className="mt-1.5 text-center text-[11px] text-slate-500">{executable ? 'Council approved and guardrails passed. You make the final call.' : 'Enabled only after a council APPROVE that passes guardrails.'}</p>

      {refunds.data && refunds.data.items.length > 0 && (
        <div className="mt-3 border-t border-white/[0.05] pt-3">
          <Label>Refunds on this case</Label>
          <ul className="mt-1.5 space-y-1">
            {refunds.data.items.map((r) => (
              <li key={r.id}>
                <Link to={`/refunds/${r.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
                  <span className="min-w-0">
                    <span className="block text-sm tabular-nums text-slate-100">{r.amount} {r.currency}</span>
                    <span className="mono block truncate text-[11px] text-slate-500">{r.paypalRefundId ?? r.id}</span>
                  </span>
                  <StatusBadge status={r.status === 'unknown' ? 'RECONCILING' : r.status.toUpperCase()} tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
