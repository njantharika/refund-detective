import { describe, it, expect } from 'vitest';
import { computeFactSheet, checkRefundAmount, type FactSheetInput } from '../src/services/investigation/rules.js';
import { fromMinor, toMinor } from '../src/services/investigation/money.js';
import { normalizeOrder } from '../src/services/paypal/paypal-transaction.service.js';
import { orderFixture } from './helpers.js';

const CAP = '3C679366HH908993F';
const base = (over: Partial<FactSheetInput> = {}, refunds: { id: string; value: string; status?: string }[] = [], amount = '42.00'): FactSheetInput => ({
  order: normalizeOrder(orderFixture({ captureId: CAP, amount, refunds })),
  targetCaptureId: CAP,
  disputes: [],
  appRefunds: [],
  locks: [],
  now: new Date('2026-11-12T00:00:00Z'),
  ...over,
});

describe('money', () => {
  it('converts exactly without floats', () => {
    expect(toMinor('42.00', 'USD')).toBe(4200);
    expect(toMinor('0.1', 'USD')).toBe(10);
    expect(toMinor('1000', 'JPY')).toBe(1000);
    expect(fromMinor(4200 - 1033, 'USD')).toBe('31.67');
    expect(fromMinor(5, 'USD')).toBe('0.05');
    expect(() => toMinor('1.234', 'USD')).toThrow(/decimal places/);
    expect(() => toMinor('abc', 'USD')).toThrow();
  });
});

describe('FactSheet: remaining refundable', () => {
  it('no refunds: full amount refundable', () => {
    const fs = computeFactSheet(base());
    expect(fs).toMatchObject({ capturedAmount: '42.00', completedRefundTotal: '0.00', pendingRefundTotal: '0.00', remainingRefundable: '42.00', currency: 'USD', refundEligible: true });
  });

  it('partial refund leaves the remainder', () => {
    const fs = computeFactSheet(base({}, [{ id: 'R1', value: '10.33' }]));
    expect(fs.completedRefundTotal).toBe('10.33');
    expect(fs.remainingRefundable).toBe('31.67');
    expect(fs.refundEligible).toBe(true);
  });

  it('multiple refunds are summed', () => {
    const fs = computeFactSheet(base({}, [{ id: 'R1', value: '10.00' }, { id: 'R2', value: '12.00' }, { id: 'R3', value: '5.00', status: 'CANCELLED' }]));
    expect(fs.completedRefundTotal).toBe('22.00');
    expect(fs.remainingRefundable).toBe('20.00');
  });

  it('fully refunded capture: nothing left, refund blocked', () => {
    const fs = computeFactSheet(base({}, [{ id: 'R1', value: '42.00' }]));
    expect(fs.remainingRefundable).toBe('0.00');
    expect(fs.refundEligible).toBe(false);
    expect(fs.refundBlockers.join(' ')).toMatch(/Nothing left to refund/);
  });

  it('pending refunds reduce remaining and block a new refund', () => {
    const fs = computeFactSheet(base({}, [{ id: 'R1', value: '30.00', status: 'PENDING' }]));
    expect(fs.pendingRefundTotal).toBe('30.00');
    expect(fs.remainingRefundable).toBe('12.00');
    expect(fs.refundBlockers.join(' ')).toMatch(/already in progress/);
  });

  it('fresh get_refund status overrides the order snapshot', () => {
    const fs = computeFactSheet(base({ refundLookups: { R1: { id: 'R1', status: 'COMPLETED', amount: { value: '30.00', currency: 'USD' }, createdAt: null, updatedAt: null, noteToPayer: null } } }, [{ id: 'R1', value: '30.00', status: 'PENDING' }]));
    expect(fs.pendingRefundTotal).toBe('0.00');
    expect(fs.completedRefundTotal).toBe('30.00');
  });

  it('currency mismatch is flagged and blocks', () => {
    const input = base({}, [{ id: 'R1', value: '10.00' }]);
    input.order!.captures[0].refunds[0].amount = { value: '10.00', currency: 'EUR' };
    const fs = computeFactSheet(input);
    expect(fs.currencyMismatch).toBe(true);
    expect(fs.refundEligible).toBe(false);
  });

  it('in-app pending/unknown refund attempts and held locks block', () => {
    const pending = computeFactSheet(base({ appRefunds: [{ id: 'a1', captureId: CAP, amount: '5.00', currency: 'USD', status: 'requested', paypalRefundId: null }] }));
    expect(pending.appPendingRefund).toBe(true);
    expect(pending.remainingRefundable).toBe('37.00');
    const unknown = computeFactSheet(base({ appRefunds: [{ id: 'a1', captureId: CAP, amount: '5.00', currency: 'USD', status: 'unknown', paypalRefundId: null }] }));
    expect(unknown.refundBlockers.join(' ')).toMatch(/reconciled/);
    const locked = computeFactSheet(base({ locks: [{ resourceId: CAP, operation: 'refund', expiresAt: '2026-11-12T00:05:00Z' }] }));
    expect(locked.lockHeld).toBe(true);
    const expired = computeFactSheet(base({ locks: [{ resourceId: CAP, operation: 'refund', expiresAt: '2026-11-11T00:00:00Z' }] }));
    expect(expired.lockHeld).toBe(false);
  });

  it('a reconciled in-app refund (reflected in PayPal) is not double counted', () => {
    const fs = computeFactSheet(base({ appRefunds: [{ id: 'a1', captureId: CAP, amount: '10.00', currency: 'USD', status: 'pending', paypalRefundId: 'R1' }] }, [{ id: 'R1', value: '10.00', status: 'PENDING' }]));
    expect(fs.pendingRefundTotal).toBe('10.00');
  });

  it('open disputes block and are listed', () => {
    const fs = computeFactSheet(base({ disputes: [{ id: 'PP-D-1', status: 'OPEN', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'INQUIRY', amount: null, createdAt: null, updatedAt: null, disputedTransactionIds: [CAP], outcome: null }] }));
    expect(fs.openDisputes).toEqual(['PP-D-1']);
    expect(fs.refundBlockers.join(' ')).toMatch(/dispute flow/);
  });

  it('detects conflicting statuses', () => {
    const input = base({}, [{ id: 'R1', value: '10.00' }]);
    input.order!.captures[0].status = 'REFUNDED';
    expect(computeFactSheet(input).conflictingStatuses.join(' ')).toMatch(/REFUNDED but completed refunds total 10.00/);
  });

  it('reports missing order evidence without inventing numbers', () => {
    const fs = computeFactSheet({ order: null, targetCaptureId: CAP, disputes: [], appRefunds: [], locks: [], unavailableSources: ['list_transactions: 403'] });
    expect(fs.capturedAmount).toBeNull();
    expect(fs.remainingRefundable).toBeNull();
    expect(fs.missingEvidence).toEqual(expect.arrayContaining(['list_transactions: 403', 'Order record (get_order) not available']));
    expect(fs.refundEligible).toBe(false);
  });
});

describe('checkRefundAmount', () => {
  const fs = computeFactSheet(base({}, [{ id: 'R1', value: '10.00' }]));
  it('accepts amounts within remaining', () => expect(checkRefundAmount(fs, { value: '32.00', currency: 'USD' }).ok).toBe(true));
  it('caps amounts above remaining', () => expect(checkRefundAmount(fs, { value: '42.00', currency: 'USD' })).toMatchObject({ ok: false, cappedTo: '32.00' }));
  it('rejects currency mismatch', () => expect(checkRefundAmount(fs, { value: '1.00', currency: 'EUR' })).toMatchObject({ ok: false, cappedTo: null }));
  it('rejects zero and malformed', () => {
    expect(checkRefundAmount(fs, { value: '0.00', currency: 'USD' }).ok).toBe(false);
    expect(checkRefundAmount(fs, { value: '1.999', currency: 'USD' }).ok).toBe(false);
  });
});
