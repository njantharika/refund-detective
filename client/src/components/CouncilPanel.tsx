import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, Gavel, Loader2, Scale, ShieldAlert, ShieldCheck, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { api, type CouncilArgument, type Deliberation, type Investigation, type JudgeVerdict, type SideResult, type Verdict } from '../lib/api';
import { Button, Card, cx, EmptyState, ErrorState, EvidenceChip, Notice, Pill } from './ui';

export const VERDICT_META: Record<Verdict, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'violet'; icon: typeof Check }> = {
  APPROVE: { label: 'APPROVE', tone: 'success', icon: CheckCircle2 },
  APPROVE_MODIFIED: { label: 'APPROVE · MODIFIED', tone: 'success', icon: CheckCircle2 },
  REJECT: { label: 'REJECT', tone: 'danger', icon: X },
  NEEDS_MORE_INFO: { label: 'NEEDS MORE INFO', tone: 'warning', icon: AlertTriangle },
  ESCALATE_TO_HUMAN: { label: 'ESCALATE TO HUMAN', tone: 'violet', icon: ShieldAlert },
};

export function VerdictBadge({ v }: { v: Verdict | null | undefined }) {
  if (!v) return null;
  const m = VERDICT_META[v];
  return (
    <Pill tone={m.tone} icon={m.icon}>
      {m.label}
    </Pill>
  );
}

const isRunning = (d: Deliberation | undefined) => !!d && d.stage !== 'complete' && d.stage !== 'failed';

export function useCouncil(investigationId: string) {
  const list = useQuery({
    queryKey: ['council', investigationId],
    queryFn: () => api<{ items: Deliberation[] }>(`/api/investigations/${investigationId}/council`),
    refetchInterval: (q) => (q.state.data?.items.some(isRunning) ? 1500 : false),
  });
  return { list, latest: list.data?.items[0] };
}

export function CouncilPanel({ inv, onSelect, onReview, onReviewDispute }: { inv: Investigation; onSelect: (id: string) => void; onReview: (d: Deliberation) => void; onReviewDispute?: (d: Deliberation) => void }) {
  const qc = useQueryClient();
  const { list, latest } = useCouncil(inv.id);
  const proposed = inv.report?.proposedDecision;
  const defaultAmount = (proposed?.type === 'refund' && proposed.amount) || inv.factSheet?.remainingRefundable || '';
  const [amount, setAmount] = useState(defaultAmount);
  useEffect(() => setAmount(defaultAmount), [defaultAmount]);
  const start = useMutation({
    mutationFn: (v: 'refund' | 'next_action' | { disputeId: string }) =>
      api<{ deliberationId: string }>(`/api/investigations/${inv.id}/council`, {
        method: 'POST',
        body: JSON.stringify(typeof v === 'object' ? { decisionType: 'dispute_accept', disputeId: v.disputeId } : { decisionType: v, amount: v === 'refund' ? amount || null : null }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['council', inv.id] }),
  });
  const ready = inv.stage === 'ready';
  const running = isRunning(latest);
  const valid = new Set(inv.evidence.map((e) => e.id));
  const currency = inv.factSheet?.currency ?? 'USD';

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Scale aria-hidden className="h-4 w-4 text-violet-300" /> Decision Council
        </span>
      }
      subtitle="Adversarial review of every money-moving decision. One agent argues for, one argues against, an impartial Judge rules, and code guardrails have the final word."
      actions={latest?.finalOutcome ? <VerdictBadge v={latest.finalOutcome} /> : undefined}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="council-amount" className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Proposed refund ({currency})
          </label>
          <input
            id="council-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            inputMode="decimal"
            pattern="^\d+(\.\d{1,2})?$"
            disabled={!ready || running}
            className="mono mt-1 block w-32 rounded-lg border border-white/10 bg-ink-900 px-3 py-1.5 text-sm text-slate-100 focus:border-electric/50 focus:outline-none disabled:opacity-50"
          />
        </div>
        <Button onClick={() => start.mutate('refund')} disabled={!ready || running || start.isPending || !/^\d+(\.\d{1,2})?$/.test(amount)}>
          <Gavel className="h-4 w-4" /> Convene council
        </Button>
        <Button variant="outline" onClick={() => start.mutate('next_action')} disabled={!ready || running || start.isPending}>
          Debate next action
        </Button>
        {inv.factSheet?.openDisputes.map((id) => (
          <Button key={id} variant="outline" onClick={() => start.mutate({ disputeId: id })} disabled={!ready || running || start.isPending}>
            <Scale className="h-4 w-4" /> Debate accepting claim {id}
          </Button>
        ))}
        {inv.factSheet?.remainingRefundable && <span className="text-xs text-slate-500">Remaining refundable: {inv.factSheet.remainingRefundable} {currency}</span>}
      </div>
      {start.error && (
        <div className="mt-3">
          <ErrorState title="Could not convene the council" error={start.error} />
        </div>
      )}
      {list.error && (
        <div className="mt-3">
          <ErrorState error={list.error} />
        </div>
      )}

      {!latest && !list.isLoading && (
        <div className="mt-4">
          <EmptyState icon={Scale} title="No deliberation yet">
            {ready ? 'Convene the council to debate the proposed refund before any money moves.' : 'Available once the investigation report is ready.'}
          </EmptyState>
        </div>
      )}

      {latest && (
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Debating:</span>
            <span className="font-medium text-slate-200">{latest.proposal.summary}</span>
            <Pill tone="neutral">{latest.proposal.source === 'merchant' ? 'amount set by merchant' : 'investigator proposal'}</Pill>
          </div>

          {running && <CouncilProgress d={latest} />}
          {latest.stage === 'failed' && <ErrorState title="Council failed" error={latest.error ?? 'Unknown error'} />}

          <div className="grid gap-4 lg:grid-cols-2">
            <SideColumn side="advocate" result={latest.advocate} running={running && latest.stage === 'arguing'} valid={valid} onSelect={onSelect} />
            <SideColumn side="challenger" result={latest.challenger} running={running && latest.stage === 'arguing'} valid={valid} onSelect={onSelect} />
          </div>

          {latest.stage === 'complete' && <VerdictCard d={latest} valid={valid} onSelect={onSelect} onReview={onReview} onReviewDispute={onReviewDispute} />}
        </div>
      )}
    </Card>
  );
}

function CouncilProgress({ d }: { d: Deliberation }) {
  const steps = [
    { key: 'advocate', label: 'Advocate thinking…', done: d.stage !== 'arguing' },
    { key: 'challenger', label: 'Challenger thinking…', done: d.stage !== 'arguing' },
    { key: 'judge', label: 'Judge deliberating…', done: d.stage === 'guardrails', active: d.stage === 'judging' },
    { key: 'guardrails', label: 'Guardrails checking…', done: false, active: d.stage === 'guardrails' },
  ];
  return (
    <ol role="status" aria-live="polite" className="flex flex-wrap gap-2">
      {steps.map((s) => {
        const active = s.active ?? (!s.done && d.stage === 'arguing');
        return (
          <li key={s.key} className={cx('flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ring-1 ring-inset', s.done ? 'bg-teal/10 text-teal-200 ring-teal/25' : active ? 'bg-electric/10 text-blue-200 ring-electric/30' : 'text-slate-500 ring-white/10')}>
            {s.done ? <Check aria-hidden className="h-3 w-3" /> : active ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <span aria-hidden className="h-3 w-3" />}
            {s.done ? s.label.replace(/ thinking…| deliberating…| checking…/, ' done') : s.label}
          </li>
        );
      })}
    </ol>
  );
}

function SideColumn({ side, result, running, valid, onSelect }: { side: 'advocate' | 'challenger'; result: SideResult | null; running: boolean; valid: Set<string>; onSelect: (id: string) => void }) {
  const isFor = side === 'advocate';
  return (
    <section aria-label={isFor ? 'Advocate: for' : 'Challenger: against'} className={cx('rounded-[12px] border border-white/[0.06] border-l-4 bg-ink-900/60 p-4', isFor ? 'border-l-teal' : 'border-l-rose-500')}>
      <header className="flex items-center gap-2">
        {isFor ? <ThumbsUp aria-hidden className="h-4 w-4 text-teal" /> : <ThumbsDown aria-hidden className="h-4 w-4 text-rose-400" />}
        <h3 className="text-sm font-semibold text-white">{isFor ? 'For' : 'Against'}</h3>
        <span className="text-xs text-slate-500">{isFor ? 'Advocate' : 'Challenger'}</span>
        {result?.ok && <span className="ml-auto mono text-[10px] text-slate-500">{result.model}</span>}
      </header>
      {!result && running && (
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> {isFor ? 'Advocate' : 'Challenger'} thinking…
        </p>
      )}
      {result && !result.ok && (
        <div className="mt-3">
          <Notice tone="danger" title={`${isFor ? 'Advocate' : 'Challenger'} failed`}>
            {result.error}
          </Notice>
        </div>
      )}
      {result?.ok && (
        <>
          <p className="mt-2 text-sm font-medium text-slate-100">{result.data.thesis}</p>
          <ul className="mt-3 space-y-2.5">
            {result.data.arguments.map((a, i) => (
              <ArgumentItem key={i} a={a} valid={valid} onSelect={onSelect} />
            ))}
          </ul>
          {result.data.saferAlternative && (
            <div className="mt-3 rounded-lg bg-amber-400/[0.06] p-2.5 text-xs text-amber-100 ring-1 ring-inset ring-amber-400/20">
              <span className="font-semibold">Safer alternative: </span>
              {result.data.saferAlternative.type.replace(/_/g, ' ')}
              {result.data.saferAlternative.amount ? ` (${result.data.saferAlternative.amount})` : ''}: {result.data.saferAlternative.rationale}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ArgumentItem({ a, valid, onSelect }: { a: CouncilArgument; valid: Set<string>; onSelect: (id: string) => void }) {
  const ignored = a.citationStatus !== 'valid';
  return (
    <li className={cx('text-sm', ignored && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={a.kind === 'evidence' ? 'success' : a.kind === 'risk' ? 'warning' : 'info'}>{a.kind.replace('_', ' ')}</Pill>
        <Pill tone="neutral">{a.weight}</Pill>
        {ignored && (
          <Pill tone="danger" icon={X}>
            uncited · ignored
          </Pill>
        )}
      </div>
      <p className={cx('mt-1 text-slate-200', ignored && 'line-through decoration-rose-400/70')}>{a.claim}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {a.evidenceIds.map((id) => (
          <EvidenceChip key={id} id={id} onSelect={onSelect} invalid={!valid.has(id) || a.invalidEvidenceIds.includes(id)} />
        ))}
        {a.factSheetFields.map((f) => (
          <span key={f} className={cx('mono rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset', a.invalidFactSheetFields.includes(f) ? 'text-slate-500 line-through ring-white/10' : 'bg-violet/10 text-violet-200 ring-violet/25')} title="FactSheet field">
            fs.{f}
          </span>
        ))}
      </div>
    </li>
  );
}

function VerdictCard({ d, valid, onSelect, onReview, onReviewDispute }: { d: Deliberation; valid: Set<string>; onSelect: (id: string) => void; onReview: (d: Deliberation) => void; onReviewDispute?: (d: Deliberation) => void }) {
  const j = d.judge && !('error' in d.judge && d.judge.error) ? (d.judge as JudgeVerdict) : null;
  const g = d.guardrails;
  const canReview = d.decisionType === 'refund' && !!d.executable && (d.finalOutcome === 'APPROVE' || d.finalOutcome === 'APPROVE_MODIFIED');
  return (
    <section aria-label="Verdict" className="rounded-[12px] border border-white/[0.08] bg-ink-950/60 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Gavel aria-hidden className="h-4 w-4 text-violet-300" />
        <h3 className="text-sm font-semibold text-white">Verdict</h3>
        <VerdictBadge v={d.finalOutcome} />
        {j && (
          <span className="text-xs text-slate-400">
            Judge confidence {Math.round(j.confidence * 100)}% <span className="text-slate-500">(estimate)</span>
          </span>
        )}
      </header>

      {j ? (
        <>
          <p className="mt-2 text-sm text-slate-200">{j.rationale}</p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Decision</dt>
              <dd className="mt-0.5 text-sm text-slate-200">
                {j.decision.type.replace(/_/g, ' ')}
                {j.decision.amount ? ` · ${j.decision.amount} ${j.decision.currency ?? ''}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Strongest dissent</dt>
              <dd className="mt-0.5 text-sm text-slate-300">{j.strongestDissent || 'None recorded'}</dd>
            </div>
          </dl>
          {j.decisiveArguments.length > 0 && (
            <div className="mt-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Decisive arguments</h4>
              <ul className="mt-1 space-y-1.5">
                {j.decisiveArguments.map((a, i) => (
                  <li key={i} className="text-sm text-slate-300">
                    <Pill tone={a.from === 'advocate' ? 'success' : 'danger'}>{a.from}</Pill> {a.claim}{' '}
                    <span className="inline-flex flex-wrap gap-1 align-middle">
                      {a.evidenceIds.map((id) => (
                        <EvidenceChip key={id} id={id} onSelect={onSelect} invalid={!valid.has(id)} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {j.conditions.length > 0 && (
            <div className="mt-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Conditions</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-300">
                {j.conditions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-400">The Judge did not rule{d.judge && 'error' in d.judge ? `: ${d.judge.error}` : ' (a council side failed, so the Judge was not allowed to rule on one side).'}</p>
      )}

      {g && (
        <div className={cx('mt-4 rounded-lg p-3 ring-1 ring-inset', g.overridden ? 'bg-amber-400/[0.06] ring-amber-400/25' : 'bg-teal/[0.06] ring-teal/20')}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {g.overridden ? <ShieldAlert aria-hidden className="h-4 w-4 text-amber-300" /> : <ShieldCheck aria-hidden className="h-4 w-4 text-teal" />}
            <span className="font-medium text-slate-100">Guardrail result:</span>
            {g.overridden ? (
              <span className="text-amber-100">
                code overrode the Judge ({g.judgeVerdict ?? 'no verdict'} → {g.finalOutcome})
              </span>
            ) : (
              <span className="text-teal-100">all checks passed; the Judge's verdict stands</span>
            )}
          </div>
          {g.overrideReasons.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-xs text-amber-100/90">
              {g.overrideReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <details className="mt-2 text-xs text-slate-400">
            <summary className="cursor-pointer select-none">All {g.checks.length} checks (live PayPal data)</summary>
            <ul className="mt-1.5 space-y-0.5">
              {g.checks.map((c, i) => (
                <li key={i} className="flex gap-2">
                  {c.passed ? <Check aria-label="passed" className="h-3.5 w-3.5 shrink-0 text-teal" /> : <X aria-label="failed" className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
                  <span className="mono text-slate-500">{c.rule}</span> {c.detail}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {d.decisionType === 'dispute_accept' && (
        <div className="mt-4">
          <Button variant="danger" className="w-full py-2" disabled={!d.executableDispute} onClick={() => onReviewDispute?.(d)}>
            <Scale className="h-4 w-4" /> Review &amp; accept claim{d.executableDispute ? ` ${d.executableDispute.disputeId}` : ''}
          </Button>
          <p className="mt-1.5 text-center text-[11px] text-slate-500">{d.executableDispute ? 'Opens a confirmation step. Nothing executes until you confirm.' : `Disabled: final outcome is ${d.finalOutcome?.replace(/_/g, ' ') ?? 'pending'}.`}</p>
        </div>
      )}
      {d.decisionType === 'refund' && (
        <div className="mt-4">
          <Button className="w-full py-2" disabled={!canReview} onClick={() => onReview(d)}>
            <Gavel className="h-4 w-4" /> Review &amp; approve refund{d.executable ? ` · ${d.executable.currency} ${d.executable.amount}` : ''}
          </Button>
          <p className="mt-1.5 text-center text-[11px] text-slate-500">{canReview ? 'Opens a confirmation step. Nothing executes until you confirm.' : `Disabled: final outcome is ${d.finalOutcome?.replace(/_/g, ' ') ?? 'pending'}.`}</p>
        </div>
      )}
    </section>
  );
}
