import type { NormalizedTransaction } from './paypal/paypal.types.js';

/**
 * Demo mode: used ONLY when no PayPal credentials are configured. Clearly labelled sample rows
 * (IDs prefixed DEMO-, source "demo_sample") so the UI can be explored. Never presented as PayPal data;
 * investigations, councils and refunds are refused in this mode.
 */
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const row = (n: number, status: string, value: string, daysAgo: number): NormalizedTransaction => ({
  transactionId: `DEMO-CAPTURE-${String(n).padStart(4, '0')}`,
  orderId: `DEMO-ORDER-${String(n).padStart(4, '0')}`,
  captureId: `DEMO-CAPTURE-${String(n).padStart(4, '0')}`,
  status,
  eventCode: null,
  amount: { value, currency: 'USD' },
  fee: null,
  initiatedAt: day(daysAgo),
  updatedAt: day(daysAgo),
  payerCountry: null,
  note: 'Sample data (Demo mode)',
  source: 'demo_sample' as NormalizedTransaction['source'],
});

export const DEMO_TRANSACTIONS: NormalizedTransaction[] = [
  row(1, 'COMPLETED', '42.00', 1),
  row(2, 'PARTIALLY_REFUNDED', '64.00', 2),
  row(3, 'REFUNDED', '25.00', 3),
  row(4, 'PENDING', '18.50', 4),
  row(5, 'DECLINED', '99.00', 6),
  row(6, 'COMPLETED', '12.75', 9),
];

export const DEMO_MODE_MESSAGE = 'Demo mode: no PayPal Sandbox credentials are configured. Sample data is shown; investigations and refunds are disabled. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.';
