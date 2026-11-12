import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Bot, CheckCircle2, CircleDashed, Copy, Database, Download, Gavel, Loader2, MessageSquare, RefreshCw, Search, Send, ShieldCheck, User } from 'lucide-react';
import { api, type Deliberation, type Evidence, type Investigation, type RefundRecord } from '../lib/api';
import { dateTime, NA } from '../lib/format';
import { reportMarkdown } from '../lib/report-md';
import { PageHeader } from '../components/Shell';
import { Button, Card, cx, EmptyState, ErrorState, EvidenceChip, Field, Notice, Pill, Skeleton, StatusBadge } from '../components/ui';
import { STAGE_LABEL } from './Investigations';
import { CouncilPanel, useCouncil, VerdictBadge } from '../components/CouncilPanel';
import { RefundModal } from '../components/RefundModal';

const SOURCE_META: Record<Evidence['source'], { label: string; icon: typeof ShieldCheck; tone: 'success' | 'info' | 'warning' | 'neutral' | 'violet' }> = {
  paypal_mcp: { label: 'PayPal · MCP', icon: ShieldCheck, tone: 'success' },
  paypal_rest: { label: 'PayPal · REST', icon: ShieldCheck, tone: 'success' },
  webhook_verified: { label: 'Verified webhook', icon: ShieldCheck, tone: 'success' },
  app_internal: { label: 'App record', icon: Database, tone: 'violet' },
  merchant_input: { label: 'Merchant input · unverified', icon: User, tone: 'warning' },
};

export function InvestigationWorkspace() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [highlight, setHighlight] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Deliberation | null>(null);
  const inv = useQuery({
    queryKey: ['investigation', id],
    queryFn: () => api<Investigation>(`/api/investigations/${id}`),
    refetchInterval: (q) => (q.state.data && (q.state.data.stage === 'collecting' || q.state.data.stage === 'analyzing') ? 1500 : false),
  });
  const refresh = useMutation({ mutationFn: () => api(`/api/investigations/${id}/refresh-evidence`, { method: 'POST', body: '{}' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['investigation', id] }) });

  const select = useCallback((evId: string) => {
    setHighlight(evId);
    document.getElementById(`ev-${evId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setHighlight((h) => (h === evId ? null : h)), 2500);
  }, []);

  const d = inv.data;
  if (inv.isLoading) return <Skeleton className="h-96 w-full" />;
  if (inv.error || !d) return <ErrorState title="Could not load the investigation" error={inv.error ?? 'Not found'} onRetry={() => inv.refetch()} />;
  const busy = d.stage === 'collecting' || d.stage === 'analyzing';
  const valid = new Set(d.evidence.map((e) => e.id));

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
        <div role="status" aria-live="polite" className="mb-6 flex items-center gap-3 rounded-[12px] border border-electric/25 bg-electric/[0.06] px-4 py-3 text-sm text-blue-100">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          {d.stageDetail ?? 'Working…'}
        </div>
      )}
      {d.stage === 'failed' && <div className="mb-6"><ErrorState title="Investigation failed" error={d.error ?? 'Unknown error'} onRetry={() => refresh.mutate()} /></div>}
      {d.stage === 'ai_unavailable' && (
        <div className="mb-6">
          <Notice title="AI not configured">Evidence and the FactSheet were collected, but no AI report was generated. Configure an AI provider in .env and refresh.</Notice>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)_minmax(300px,1.2fr)]">
        {/* LEFT: case + complaint + FactSheet */}
        <div className="space-y-6">
          <Card title="Transaction">
            <dl className="grid grid-cols-1 gap-3">
              <Field label="Order" mono>{d.orderId ?? NA}</Field>
              <Field label="Capture" mono>{d.captureId ?? NA}</Field>
              <Field label="Opened">{dateTime(d.createdAt)}</Field>
            </dl>
          </Card>
          <Card title="Complaint" subtitle="Unverified allegation, treated as data">
            <p className="whitespace-pre-wrap text-sm text-slate-300">{d.complaint}</p>
          </Card>
          <FactSheetCard inv={d} />
        </div>

        {/* CENTRE: report + timeline */}
        <div className="min-w-0 space-y-6">
          <ReportSection inv={d} valid={valid} onSelect={select} highlight={highlight} busy={busy} />
          <Timeline inv={d} highlight={highlight} />
        </div>

        {/* RIGHT: chat, council, resolution */}
        <div className="space-y-6">
          <ChatPanel inv={d} valid={valid} onSelect={select} />
          <ResolutionCard inv={d} onReview={setReviewing} />
        </div>
      </div>

      <div className="mt-6">
        <CouncilPanel inv={d} onSelect={select} onReview={setReviewing} />
      </div>
      <RefundModal inv={d} deliberation={reviewing} onClose={() => setReviewing(null)} />
    </>
  );
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

function FactSheetCard({ inv }: { inv: Investigation }) {
  const fs = inv.factSheet;
  if (!fs) return <Card title="FactSheet"><Skeleton className="h-32" /></Card>;
  return (
    <Card title="FactSheet" subtitle="Computed by code from PayPal data. The AI cannot override it.">
      <dl className="grid grid-cols-2 gap-3">
        <Field label="Capture status">{fs.captureStatus ?? NA}</Field>
        <Field label="Captured"><Money v={fs.capturedAmount} c={fs.currency} /></Field>
        <Field label="Refunded"><Money v={fs.completedRefundTotal} c={fs.currency} /></Field>
        <Field label="Pending refunds"><Money v={fs.pendingRefundTotal} c={fs.currency} /></Field>
        <Field label="Remaining refundable">
          <span className="font-semibold text-white"><Money v={fs.remainingRefundable} c={fs.currency} /></span>
        </Field>
        <Field label="Open disputes">{fs.openDisputes.length ? fs.openDisputes.join(', ') : 'None'}</Field>
      </dl>
      {fs.conflictingStatuses.length > 0 && (
        <div className="mt-4">
          <Notice tone="danger" title="Conflicting statuses">
            <ul className="list-disc pl-4">{fs.conflictingStatuses.map((c) => <li key={c}>{c}</li>)}</ul>
          </Notice>
        </div>
      )}
    </Card>
  );
}

function ReportSection({ inv, valid, onSelect, highlight, busy }: { inv: Investigation; valid: Set<string>; onSelect: (id: string) => void; highlight: string | null; busy: boolean }) {
  const r = inv.report;
  const verified = new Map(inv.evidence.map((e) => [e.id, e.verified]));
  if (!r) {
    return (
      <Card title="Findings">
        {busy ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
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
  return (
    <>
      <Card title="Case summary" subtitle={`Transaction status: ${r.transactionStatus}`}>
        <p className="text-sm leading-relaxed text-slate-200">{r.caseSummary}</p>
      </Card>

      <Card title={`Findings (${r.findings.length})`} subtitle="Every finding cites PayPal or app evidence">
        <ul className="space-y-3">
          {r.findings.map((f, i) => {
            const allegationOnly = f.evidenceIds.every((x) => verified.get(x) === false);
            return (
              <li key={i} className="rounded-lg border border-white/[0.05] bg-ink-900/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{f.title}</span>
                  <Pill tone={f.kind === 'observed' ? 'success' : 'info'}>{f.kind}</Pill>
                  <Pill tone={f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warning' : 'neutral'}>{f.severity}</Pill>
                  {allegationOnly && <Pill tone="warning" icon={AlertTriangle}>allegation only</Pill>}
                </div>
                <p className="mt-1.5 text-sm text-slate-300">{f.explanation}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{chips(f.evidenceIds)}</div>
              </li>
            );
          })}
        </ul>
        {removed.length > 0 && (
          <div className="mt-4 rounded-lg border border-dashed border-white/10 p-3">
            <p className="text-xs font-medium text-slate-400">{removed.length} uncited claim(s) removed by code</p>
            <ul className="mt-1 space-y-1">
              {removed.map((x, i) => (
                <li key={i} className="text-xs text-slate-500">
                  <span className="line-through">{x.title}</span> · {x.reason === 'uncited' ? 'no citation' : `cited nonexistent ${x.invalidIds.join(', ')}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Likely root cause">
        <p className="text-sm text-slate-200">{r.likelyRootCause.description}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ConfidenceMeter value={r.likelyRootCause.confidence} />
          <div className="flex flex-wrap gap-1.5">{chips(r.likelyRootCause.supportingEvidenceIds)}</div>
        </div>
        {r.likelyRootCause.limitations.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-slate-400">
            {r.likelyRootCause.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
        {r.alternativeExplanations.length > 0 && (
          <div className="mt-4">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Alternative explanations</h4>
            <ul className="mt-2 space-y-2">
              {r.alternativeExplanations.map((a, i) => (
                <li key={i} className="text-sm text-slate-300">
                  {a.description} <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">{chips(a.evidenceIds)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {r.missingInformation.length > 0 && (
        <Card title="Missing information">
          <ul className="space-y-1.5">
            {r.missingInformation.map((m) => (
              <li key={m} className="flex items-start gap-2 text-sm text-slate-300">
                <CircleDashed aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /> {m}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
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
    <Card title="Evidence timeline" subtitle={`${inv.evidence.length} item(s) · ${missing.length} missing`}>
      <ol className="relative space-y-3 border-l border-white/[0.07] pl-5">
        {items.map((e) => {
          const meta = SOURCE_META[e.source];
          const I = meta.icon;
          return (
            <li key={e.id} id={`ev-${e.id}`} className={cx('relative scroll-mt-24 rounded-lg p-3 transition-colors', highlight === e.id ? 'bg-electric/[0.12] ring-1 ring-electric/50' : 'bg-ink-900/50')}>
              <span aria-hidden className={cx('absolute -left-[27px] top-4 h-3 w-3 rounded-full ring-4 ring-ink-850', e.verified ? 'bg-teal' : e.source === 'merchant_input' ? 'bg-amber-400' : 'bg-violet')} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-[12px] text-slate-400">{e.id}</span>
                <Pill tone={meta.tone} icon={I}>{meta.label}</Pill>
                <span className="text-[11px] text-slate-500">{e.type.replace(/_/g, ' ')}</span>
                <span className="ml-auto text-[11px] text-slate-500">{e.observedAt ? dateTime(e.observedAt) : 'time not available'}</span>
              </div>
              <p className="mt-1 text-sm text-slate-200">{e.description}</p>
              {e.type === 'merchant_complaint' && typeof e.normalized.complaint === 'string' && <p className="mt-1 text-xs italic text-slate-400">“{e.normalized.complaint}”</p>}
              {e.provenance?.tool && <p className="mt-1 text-[11px] text-slate-500">via <span className="mono">{e.provenance.tool}</span>{e.provenance.path === 'rest_fallback' ? ' (REST fallback)' : ''}</p>}
            </li>
          );
        })}
        {missing.map((m) => (
          <li key={m} className="relative rounded-lg border border-dashed border-white/10 p-3">
            <span aria-hidden className="absolute -left-[27px] top-4 h-3 w-3 rounded-full border-2 border-slate-500 bg-ink-850" />
            <div className="flex items-center gap-2">
              <Pill tone="neutral" icon={CircleDashed}>Missing</Pill>
            </div>
            <p className="mt-1 text-sm text-slate-400">{m}</p>
          </li>
        ))}
      </ol>
    </Card>
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
    <Card title="Ask the investigator" subtitle="Follow-ups use the same evidence">
      <div className="max-h-80 space-y-3 overflow-y-auto" aria-live="polite">
        {inv.messages.length === 0 && <p className="text-sm text-slate-500">{ready ? 'e.g. “Was the payment actually captured?”' : 'Available once the report is ready.'}</p>}
        {inv.messages.map((m) => (
          <div key={m.id} className={cx('flex gap-2', m.role === 'merchant' && 'flex-row-reverse')}>
            <div className={cx('mt-0.5 rounded-full p-1.5', m.role === 'merchant' ? 'bg-white/[0.06]' : 'bg-violet/15')}>
              {m.role === 'merchant' ? <User aria-hidden className="h-3.5 w-3.5 text-slate-300" /> : <Bot aria-hidden className="h-3.5 w-3.5 text-violet-300" />}
            </div>
            <div className={cx('max-w-[85%] rounded-lg px-3 py-2 text-sm', m.role === 'merchant' ? 'bg-white/[0.05] text-slate-200' : 'bg-ink-900 text-slate-200 ring-1 ring-white/[0.05]')}>
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.role === 'investigator' && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
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
      {send.error && <div className="mt-3"><ErrorState title="Question failed" error={send.error} /></div>}
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label htmlFor="chat" className="sr-only">Ask a follow-up question</label>
        <input id="chat" value={msg} onChange={(e) => setMsg(e.target.value)} disabled={!ready || send.isPending} maxLength={2000} placeholder={ready ? 'Ask about this payment…' : 'Waiting for report…'} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-electric/50 focus:outline-none disabled:opacity-50" />
        <Button type="submit" disabled={!ready || send.isPending || !msg.trim()} aria-label="Send question">
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
    </Card>
  );
}

function ResolutionCard({ inv, onReview }: { inv: Investigation; onReview: (d: Deliberation) => void }) {
  const fs = inv.factSheet;
  const p = inv.report?.proposedDecision;
  const { latest } = useCouncil(inv.id);
  const refunds = useQuery({ queryKey: ['refunds', inv.id], queryFn: () => api<{ items: RefundRecord[] }>(`/api/investigations/${inv.id}/refunds`), refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'unknown' || r.status === 'requested') ? 4000 : false) });
  const executable = latest?.decisionType === 'refund' && latest.executable && (latest.finalOutcome === 'APPROVE' || latest.finalOutcome === 'APPROVE_MODIFIED') && !refunds.data?.items.some((r) => r.deliberationId === latest.id);
  return (
    <Card title="Resolution" subtitle="Eligibility is deterministic and recomputed live before any refund.">
      {!fs ? (
        <Skeleton className="h-16" />
      ) : (
        <>
          <div className="flex items-center gap-2">
            {fs.refundEligible ? <CheckCircle2 aria-hidden className="h-4 w-4 text-teal" /> : <AlertTriangle aria-hidden className="h-4 w-4 text-amber-300" />}
            <span className="text-sm font-medium text-slate-100">{fs.refundEligible ? `Eligible · up to ${fs.remainingRefundable} ${fs.currency}` : 'Not eligible (at investigation time)'}</span>
          </div>
          {fs.refundBlockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{fs.refundBlockers.map((b) => <li key={b}>{b}</li>)}</ul>}
        </>
      )}
      {p && (
        <div className="mt-4 rounded-lg border border-white/[0.06] bg-ink-900/60 p-3">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <MessageSquare aria-hidden className="h-3.5 w-3.5" /> Investigator's proposal (recommendation only)
          </div>
          <div className="mt-1 text-sm text-slate-100">
            <span className="font-medium">{p.type.replace(/_/g, ' ')}</span>
            {p.amount && <span className="tabular-nums"> · {p.amount} {p.currency}</span>}
          </div>
          <p className="mt-1 text-xs text-slate-400">{p.reason}</p>
        </div>
      )}
      {latest && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-300">
          Latest council: <VerdictBadge v={latest.finalOutcome} /> {!latest.finalOutcome && <span className="text-xs text-slate-500">deliberating…</span>}
        </div>
      )}
      <Button className="mt-4 w-full" disabled={!executable} onClick={() => latest && onReview(latest)}>
        <Gavel className="h-4 w-4" /> Review &amp; approve refund{executable && latest?.executable ? ` · ${latest.executable.currency} ${latest.executable.amount}` : ''}
      </Button>
      <p className="mt-2 text-center text-[11px] text-slate-500">{executable ? 'Council approved and guardrails passed. You make the final call.' : 'Enabled only after a council APPROVE that passes guardrails.'}</p>

      {refunds.data && refunds.data.items.length > 0 && (
        <div className="mt-5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Refunds on this case</h4>
          <ul className="mt-2 space-y-2">
            {refunds.data.items.map((r) => (
              <li key={r.id} className="rounded-lg border border-white/[0.05] bg-ink-900/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm tabular-nums text-slate-100">{r.amount} {r.currency}</span>
                  <StatusBadge status={r.status === 'unknown' ? 'RECONCILING' : r.status.toUpperCase()} tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'} />
                </div>
                <div className="mono mt-0.5 truncate text-[11px] text-slate-500">{r.paypalRefundId ?? r.id}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
