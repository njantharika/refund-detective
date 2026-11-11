import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Activity, Bell, FileSearch, Gauge, LineChart, ListOrdered, RotateCcw, Scale, Search, Settings, ShieldCheck, Store } from 'lucide-react';
import { cx } from './ui';

export const NAV = [
  { to: '/', label: 'Overview', icon: Gauge, end: true },
  { to: '/transactions', label: 'Transactions', icon: ListOrdered },
  { to: '/investigations', label: 'Investigations', icon: FileSearch },
  { to: '/refunds', label: 'Refunds', icon: RotateCcw },
  { to: '/disputes', label: 'Disputes', icon: Scale },
  { to: '/events', label: 'Event Monitor', icon: Activity },
  { to: '/insights', label: 'Insights', icon: LineChart },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#162036" />
        <circle cx="14" cy="14" r="7" fill="none" stroke="#7C5CFF" strokeWidth="3" />
        <path d="M19 19l6 6" stroke="#14B8A6" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight text-white">Refund Detective</div>
        <div className="hidden text-[10px] text-slate-500 sm:block">Every payment has a story.</div>
      </div>
    </div>
  );
}

export function SandboxPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold tracking-[0.12em] text-amber-300 ring-1 ring-inset ring-amber-400/30" title="All PayPal calls use the Sandbox environment. No real money moves.">
      <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
      SANDBOX
    </span>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (v) nav(`/transactions?q=${encodeURIComponent(v)}&open=${encodeURIComponent(v)}`);
  };
  return (
    <form onSubmit={submit} role="search" className="relative hidden w-full max-w-sm md:block">
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search by transaction or order ID"
        placeholder="Transaction or order ID…"
        className="mono w-full rounded-lg border border-white/[0.07] bg-ink-900 py-1.5 pl-9 pr-3 text-[13px] text-slate-200 placeholder:font-sans placeholder:text-slate-500 focus:border-electric/50 focus:outline-none"
      />
    </form>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/[0.05] bg-ink-900/70 lg:flex">
        <div className="px-5 py-5">
          <Logo />
        </div>
        <nav aria-label="Primary" className="flex-1 space-y-0.5 px-3">
          {NAV.map(({ to, label, icon: I, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors', isActive ? 'bg-violet/[0.12] font-medium text-white ring-1 ring-inset ring-violet/25' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200')
              }
            >
              <I aria-hidden className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="m-3 rounded-lg border border-white/[0.05] bg-ink-850 p-3 text-[11px] leading-relaxed text-slate-500">
          AI recommends. Code validates. <span className="text-slate-300">You approve.</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-white/[0.05] bg-ink-950/85 px-4 py-3 backdrop-blur sm:px-6">
          <div className="lg:hidden">
            <Logo />
          </div>
          <SandboxPill />
          <div className="flex flex-1 justify-center">
            <GlobalSearch />
          </div>
          <button type="button" aria-label="Notifications" className="rounded-lg p-2 text-slate-400 hover:bg-white/[0.05] hover:text-white">
            <Bell className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-2.5 py-1.5" title="Sandbox merchant account">
            <Store aria-hidden className="h-4 w-4 text-teal" />
            <span className="hidden text-xs text-slate-300 sm:inline">Sandbox merchant</span>
          </div>
        </header>
        <nav aria-label="Primary mobile" className="flex gap-1 overflow-x-auto border-b border-white/[0.05] px-3 py-2 lg:hidden">
          {NAV.map(({ to, label, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('whitespace-nowrap rounded-md px-2.5 py-1 text-xs', isActive ? 'bg-violet/15 text-white' : 'text-slate-400')}>
              {label}
            </NavLink>
          ))}
        </nav>
        <main className="bg-grid flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
