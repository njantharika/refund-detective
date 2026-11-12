import { describe, it, expect, vi, afterEach } from 'vitest';
import { PayPalAuth } from '../src/services/paypal/paypal-auth.js';
import { PayPalToolRegistry, isAuthError } from '../src/services/paypal/paypal-tool-registry.js';
import { PayPalError } from '../src/services/paypal/paypal.types.js';
import { FakeTransport, testConfig } from './helpers.js';

const ccConfig = () => testConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ACCESS_TOKEN: '' });
const tokenResponse = (token: string, expiresIn = 32400) => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 });
const ORDER = '5O190127TN364715T';
const expired = () => new PayPalError('Access Token not found in cache', 401, 'PAYPAL_API_ERROR', 'get_order');

afterEach(() => vi.useRealTimers());

describe('PayPal token lifecycle', () => {
  it('classifies "Access Token not found in cache" as an auth error, but not a 403 permission error', () => {
    expect(isAuthError(expired())).toBe(true);
    expect(isAuthError(new PayPalError('Access Token not found in cache', null, 'PAYPAL_API_ERROR'))).toBe(true);
    expect(isAuthError(new PayPalError('insufficient permissions', 403, 'PAYPAL_FORBIDDEN'))).toBe(false);
  });

  it('reports staleness inside the 5-minute margin and after invalidate()', async () => {
    const fetchMock = vi.fn(async () => tokenResponse('t1', 600));
    const auth = new PayPalAuth(ccConfig(), fetchMock as unknown as typeof fetch);
    expect(auth.isStale()).toBe(true);
    await auth.getToken();
    expect(auth.isStale()).toBe(false);
    expect(auth.isStale(Date.now() + 6 * 60_000)).toBe(true);
    auth.invalidate();
    expect(auth.isStale()).toBe(true);
    auth.stop();
  });

  it('retries a failed scheduled refresh instead of giving up', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) return tokenResponse('t1', 400); // refresh due ~100s later (margin 300s, floor 30s)
      if (n === 2) throw new TypeError('fetch failed'); // laptop asleep / network blip
      return tokenResponse('t2');
    });
    const auth = new PayPalAuth(ccConfig(), fetchMock as unknown as typeof fetch);
    const onToken = vi.fn();
    auth.on('token', onToken);
    await auth.getToken();
    await vi.advanceTimersByTimeAsync(100_000); // scheduled refresh fails
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000); // backoff retry succeeds
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onToken).toHaveBeenLastCalledWith('t2');
    auth.stop();
  });
});

describe('registry token guard', () => {
  const guard = () => ({ ensureFresh: vi.fn(async () => {}), recoverFromAuthError: vi.fn(async () => true) });

  it('ensures a fresh token before every call', async () => {
    const g = guard();
    const reg = new PayPalToolRegistry(new FakeTransport({ get_order: () => ({ id: ORDER }) }), null, g);
    await reg.read('get_order', { id: ORDER });
    expect(g.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('recovers once from a 401 on a read and retries', async () => {
    const g = guard();
    let calls = 0;
    const t = new FakeTransport({
      get_order: () => {
        calls++;
        if (calls === 1) throw expired();
        return { id: ORDER };
      },
    });
    const out = await new PayPalToolRegistry(t, null, g).read('get_order', { id: ORDER });
    expect(out.data).toEqual({ id: ORDER });
    expect(g.recoverFromAuthError).toHaveBeenCalledTimes(1);
    expect(t.calls).toHaveLength(2);
  });

  it('does not loop: a second 401 after recovery is surfaced', async () => {
    const g = guard();
    const t = new FakeTransport({ get_order: () => { throw expired(); } });
    await expect(new PayPalToolRegistry(t, null, g).read('get_order', { id: ORDER })).rejects.toMatchObject({ httpStatus: 401 });
    expect(t.calls).toHaveLength(2);
  });

  it('never auto-retries a write after a 401', async () => {
    const g = guard();
    const t = new FakeTransport({ create_refund: () => { throw expired(); } });
    await expect(new PayPalToolRegistry(t, null, g).write('create_refund', { capture_id: '3C679366HH908993F' }, { approved: true })).rejects.toMatchObject({ httpStatus: 401 });
    expect(g.recoverFromAuthError).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(1);
  });

  it('does not treat 403 permission errors as token problems', async () => {
    const g = guard();
    const t = new FakeTransport({ list_transactions: () => { throw new PayPalError('insufficient permissions', 403, 'PAYPAL_FORBIDDEN'); } });
    await expect(new PayPalToolRegistry(t, null, g).read('list_transactions', {})).rejects.toMatchObject({ httpStatus: 403 });
    expect(g.recoverFromAuthError).not.toHaveBeenCalled();
  });
});
