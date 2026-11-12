import { describe, it, expect } from 'vitest';
import { summarize } from '../src/routes/dashboard.js';
import { normalizeSearchTransaction } from '../src/services/paypal/paypal-transaction.service.js';

const row = (id: string, code: string, value: string) =>
  normalizeSearchTransaction({ transaction_info: { transaction_id: id, transaction_event_code: code, transaction_status: 'S', transaction_amount: { currency_code: 'USD', value }, transaction_initiation_date: '2026-11-11T05:20:56Z' } });

describe('dashboard KPI classification', () => {
  it('excludes account adjustments (T1900) from payment KPIs', () => {
    const k = summarize([row('13V47218MF604662L', 'T1900', '5000.00')], []);
    expect(k.total).toBe(0);
    expect(k.capturedVolume).toEqual({});
    expect(k.nonPaymentActivity).toBe(1);
  });
  it('counts T00xx payments and T1107 refunds separately', () => {
    const k = summarize([row('AAAAAAAAAAAAAAAA1', 'T0006', '42.00'), row('BBBBBBBBBBBBBBBB2', 'T1107', '-10.00')], []);
    expect(k.total).toBe(1);
    expect(k.capturedVolume).toEqual({ USD: 42 });
    expect(k.refunds).toMatchObject({ count: 1, completedCount: 1, pendingCount: 0, amount: { USD: 10 } });
  });
  it('reports pending refunds (e.g. PayPal dispute holds) separately from completed amounts', () => {
    const k = summarize([], [
      { id: 'R1', status: 'COMPLETED', amount: { value: '20.00', currency: 'USD' }, createdAt: null },
      { id: 'R2', status: 'PENDING', amount: { value: '51.16', currency: 'USD' }, createdAt: null },
    ]);
    expect(k.refunds).toMatchObject({ count: 2, completedCount: 1, pendingCount: 1, amount: { USD: 20 }, pendingAmount: { USD: 51.16 } });
  });
});
