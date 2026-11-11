import type { Money } from './api';

export const NA = 'Not available';

export function money(m: Money | null | undefined): string {
  if (!m) return NA;
  const n = Number(m.value);
  if (!Number.isFinite(n)) return `${m.currency} ${m.value}`;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency }).format(n);
  } catch {
    return `${m.currency} ${m.value}`;
  }
}

export function moneyMap(m: Record<string, number> | undefined): string {
  const entries = Object.entries(m ?? {});
  if (!entries.length) return money({ value: '0', currency: 'USD' });
  return entries.map(([currency, v]) => money({ value: String(v), currency })).join(' · ');
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return NA;
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const fmt = (n: number, u: string) => `${Math.round(n)} ${u}${Math.round(n) === 1 ? '' : 's'}`;
  const s = abs < 60_000 ? fmt(abs / 1000, 'second') : abs < 3_600_000 ? fmt(abs / 60_000, 'minute') : abs < 86_400_000 ? fmt(abs / 3_600_000, 'hour') : fmt(abs / 86_400_000, 'day');
  return diff >= 0 ? `${s} ago` : `in ${s}`;
}

export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : NA);
