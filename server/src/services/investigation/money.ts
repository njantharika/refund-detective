/** Exact money arithmetic in integer minor units. PayPal sends decimal strings; we never use floats for sums. */

const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD']);

export const decimalsFor = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2);

export function toMinor(value: string, currency: string): number {
  const d = decimalsFor(currency);
  const m = value.trim().match(/^(-)?(\d+)(?:\.(\d+))?$/);
  if (!m) throw new RangeError(`Invalid amount "${value}"`);
  const [, neg, whole, frac = ''] = m;
  if (frac.length > d && /[1-9]/.test(frac.slice(d))) throw new RangeError(`Amount "${value}" has more than ${d} decimal places for ${currency}`);
  const minor = Number(whole) * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || '0');
  return neg ? -minor : minor;
}

export function fromMinor(minor: number, currency: string): string {
  const d = decimalsFor(currency);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  if (d === 0) return `${neg ? '-' : ''}${abs}`;
  const s = String(abs).padStart(d + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -d)}.${s.slice(-d)}`;
}
