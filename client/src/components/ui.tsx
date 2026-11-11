import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Info, RotateCcw, X, XCircle, CircleDashed, type LucideIcon } from 'lucide-react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Card({ title, subtitle, actions, children, className, padded = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-[12px] border border-white/[0.06] bg-ink-850/80 shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset]', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.05] px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : undefined}>{children}</div>
    </section>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'violet';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-teal/10 text-teal-300 ring-teal/25',
  warning: 'bg-amber-400/10 text-amber-300 ring-amber-400/25',
  danger: 'bg-rose-500/10 text-rose-300 ring-rose-500/25',
  info: 'bg-electric/10 text-blue-300 ring-electric/25',
  neutral: 'bg-slate-400/10 text-slate-300 ring-slate-400/20',
  violet: 'bg-violet/10 text-violet-300 ring-violet/30',
};

const STATUS_TONE: Record<string, [Tone, LucideIcon]> = {
  COMPLETED: ['success', CheckCircle2],
  APPROVED: ['info', CheckCircle2],
  CREATED: ['neutral', CircleDashed],
  SAVED: ['neutral', CircleDashed],
  PAYER_ACTION_REQUIRED: ['warning', Clock],
  PENDING: ['warning', Clock],
  PARTIALLY_REFUNDED: ['violet', RotateCcw],
  REFUNDED: ['violet', RotateCcw],
  DENIED: ['danger', XCircle],
  DECLINED: ['danger', XCircle],
  FAILED: ['danger', XCircle],
  VOIDED: ['danger', XCircle],
  REVERSED: ['danger', RotateCcw],
  CANCELLED: ['neutral', XCircle],
  OPEN: ['warning', AlertTriangle],
  RESOLVED: ['success', CheckCircle2],
};

/** Colour is never the only signal: every badge carries an icon and a text label. */
export function StatusBadge({ status, tone, icon }: { status: string | null | undefined; tone?: Tone; icon?: LucideIcon }) {
  const key = (status ?? '').toUpperCase();
  const [t, I] = STATUS_TONE[key] ?? [tone ?? 'neutral', icon ?? Info];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', TONE_CLASSES[tone ?? t])}>
      <I aria-hidden className="h-3 w-3" />
      {status ? status.replace(/_/g, ' ') : 'Not available'}
    </span>
  );
}

export function Pill({ children, tone = 'neutral', icon: I }: { children: ReactNode; tone?: Tone; icon?: LucideIcon }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ring-inset', TONE_CLASSES[tone])}>
      {I && <I aria-hidden className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton rounded-md', className ?? 'h-4 w-full')} />;
}

export function EmptyState({ icon: I = Info, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 rounded-full bg-white/[0.04] p-3 ring-1 ring-white/[0.06]">
        <I aria-hidden className="h-5 w-5 text-slate-400" />
      </div>
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-slate-400">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-[12px] border border-rose-500/25 bg-rose-500/[0.06] p-4">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-rose-200">{title}</p>
        <p className="mt-0.5 break-words text-sm text-rose-200/80">{message}</p>
      </div>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'warning', title, children, icon: I = AlertTriangle }: { tone?: 'warning' | 'info' | 'danger'; title: string; children?: ReactNode; icon?: LucideIcon }) {
  const cls = { warning: 'border-amber-400/25 bg-amber-400/[0.06] text-amber-200', info: 'border-electric/25 bg-electric/[0.06] text-blue-200', danger: 'border-rose-500/25 bg-rose-500/[0.06] text-rose-200' }[tone];
  return (
    <div role="status" className={cx('flex items-start gap-3 rounded-[12px] border p-4', cls)}>
      <I aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 text-sm">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 opacity-85">{children}</div>}
      </div>
    </div>
  );
}

export function KpiTile({ label, value, hint, icon: I, loading }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; loading?: boolean }) {
  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-ink-850/80 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        {I && <I aria-hidden className="h-4 w-4 text-slate-500" />}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-50 tabular-nums">{loading ? <Skeleton className="h-7 w-20" /> : value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Button({ variant = 'primary', className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline' | 'danger' }) {
  const v = {
    primary: 'bg-violet text-white hover:bg-violet/90 disabled:bg-violet/40',
    ghost: 'text-slate-300 hover:bg-white/[0.06] hover:text-white',
    outline: 'border border-white/10 text-slate-200 hover:bg-white/[0.05]',
    danger: 'bg-rose-500 text-white hover:bg-rose-500/90 disabled:bg-rose-500/40',
  }[variant];
  return <button type="button" {...props} className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60', v, className)} />;
}

/** Side drawer with dialog semantics, Escape to close, and focus moved into the panel. */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'} tabIndex={-1} className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-white/[0.06] bg-ink-900 shadow-2xl outline-none">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0 text-sm font-semibold text-slate-100">{title}</div>
          <Button variant="ghost" onClick={onClose} aria-label="Close details">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={cx('mt-0.5 truncate text-sm text-slate-200', mono && 'mono text-[13px]')}>{children}</dd>
    </div>
  );
}
