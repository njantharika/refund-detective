import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { PayPalWebhookService, relatedIds } from '../src/services/paypal/paypal-webhook.service.js';
import { PayPalAuth } from '../src/services/paypal/paypal-auth.js';
import { applyGuardrails } from '../src/services/council/guardrails.js';
import { computeFactSheet } from '../src/services/investigation/rules.js';
import { normalizeOrder } from '../src/services/paypal/paypal-transaction.service.js';
import { metricKeys } from '../src/services/insights.service.js';
import { fieldPaths } from '../src/services/dispute/dispute-resolution.service.js';
import { openDatabase } from '../src/database/db.js';
import { PayPalError } from '../src/services/paypal/paypal.types.js';
import { buildDeps, createApp } from '../src/app.js';
import { StructuredAI } from '../src/ai/provider.js';
import { PayPalToolRegistry } from '../src/services/paypal/paypal-tool-registry.js';
import { PayPalTransactionService } from '../src/services/paypal/paypal-transaction.service.js';
import { PayPalRefundService } from '../src/services/paypal/paypal-refund.service.js';
import { PayPalDisputeService } from '../src/services/paypal/paypal-dispute.service.js';
import { FakeTransport, fakeAI, makeHarness, orderFixture, testConfig } from './helpers.js';

const ORDER = '5O190127TN364715T';
const CAP = '3C679366HH908993F';
const DISPUTE = 'PP-D-12345';

/* -------------------------------- webhooks -------------------------------- */

const event = (over: Record<string, unknown> = {}) => ({
  id: 'WH-EVT-0001',
  event_type: 'PAYMENT.CAPTURE.REFUNDED',
  create_time: '2026-11-12T06:03:10Z',
  resource: {
    id: '5YE09135FX432004L',
    status: 'COMPLETED',
    amount: { value: '20.00', currency_code: 'USD' },
    payer: { email_address: 'buyer@example.com' },
    links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${CAP}` }],
    supplementary_data: { related_ids: { order_id: ORDER } },
  },
  ...over,
});
const headers = { 'paypal-transmission-id': 't1', 'paypal-transmission-time': '2026-11-12T06:03:11Z', 'paypal-transmission-sig': 'sig', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem', 'paypal-auth-algo': 'SHA256withRSA' };

function webhookService(status: string, webhookId: string | undefined = 'WH-ID-1') {
  const db = openDatabase(':memory:');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ verification_status: status }), { status: 200 }));
  const svc = new PayPalWebhookService({ db, auth: new PayPalAuth(testConfig()), webhookId, apiBase: 'https://api-m.sandbox.paypal.com' }, fetchMock as unknown as typeof fetch);
  return { db, svc, fetchMock };
}

describe('Event Monitor: webhook signature verification', () => {
  it('verifies with PayPal verify-webhook-signature and stores a verified, linked, redacted event', async () => {
    const { db, svc, fetchMock } = webhookService('SUCCESS');
    const r = await svc.receive(headers, event());
    expect(r).toMatchObject({ status: 'stored', verified: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(JSON.parse(String(init.body))).toMatchObject({ webhook_id: 'WH-ID-1', transmission_id: 't1', auth_algo: 'SHA256withRSA', webhook_event: { id: 'WH-EVT-0001' } });
    const row = db.prepare('SELECT * FROM webhook_events').get() as Record<string, any>;
    expect(row.signature_verified).toBe(1);
    expect(row.related_ids).toBe(`,5YE09135FX432004L,${ORDER},${CAP},`);
    expect(row.payload_json).not.toContain('buyer@example.com');
  });

  it('stores a failed verification as unverified (never evidence)', async () => {
    const { db, svc } = webhookService('FAILURE');
    const r = await svc.receive(headers, event());
    expect(r.verified).toBe(false);
    expect(db.prepare('SELECT signature_verified, processing_status FROM webhook_events').get()).toMatchObject({ signature_verified: 0, processing_status: expect.stringMatching(/^rejected/) });
  });

  it('rejects events missing PayPal transmission headers without calling PayPal', async () => {
    const { svc, fetchMock } = webhookService('SUCCESS');
    const r = await svc.receive({ ...headers, 'paypal-transmission-sig': undefined }, event());
    expect(r).toMatchObject({ verified: false, reason: expect.stringMatching(/Missing headers: paypal-transmission-sig/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deduplicates on the PayPal event id', async () => {
    const { db, svc, fetchMock } = webhookService('SUCCESS');
    await svc.receive(headers, event());
    const again = await svc.receive(headers, event());
    expect(again.status).toBe('duplicate');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) FROM webhook_events').pluck().get()).toBe(1);
  });

  it('extracts related IDs from resource, related_ids and links', () => {
    expect(relatedIds(event())).toEqual(['5YE09135FX432004L', ORDER, CAP]);
  });

  it('the webhook endpoint reports Not configured (and stores nothing) without PAYPAL_WEBHOOK_ID', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/api/webhooks/paypal').set(headers).send(event());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
    expect((await request(h.app).get('/api/events')).body).toMatchObject({ configured: false, items: [] });
  });

  it('only verified events become investigation evidence', async () => {
    const h = makeHarness({ get_order: () => orderFixture({ id: ORDER, captureId: CAP }), list_transactions: () => ({ transaction_details: [] }), list_disputes: () => ({ items: [] }) });
    const ins = h.db.prepare("INSERT INTO webhook_events (id, paypal_event_id, event_type, resource_id, event_time, signature_verified, related_ids) VALUES (?,?,?,?,?,?,?)");
    ins.run('wh1', 'E1', 'PAYMENT.CAPTURE.COMPLETED', CAP, '2026-11-10T10:05:00Z', 1, `,${CAP},`);
    ins.run('wh2', 'E2', 'PAYMENT.CAPTURE.REFUNDED', 'R9', '2026-11-10T11:00:00Z', 0, `,R9,${CAP},`);
    const { collectEvidence } = await import('../src/services/investigation/evidence.js');
    const c = await collectEvidence({ db: h.db, paypal: h.paypal }, { targetId: ORDER, complaint: 'x' });
    const events = c.items.filter((e) => e.type === 'webhook_event');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'webhook_verified', verified: true, normalized: { eventId: 'E1' } });
  });
});

/* -------------------------------- disputes -------------------------------- */

const disputeRaw = (status = 'WAITING_FOR_SELLER_RESPONSE') => ({
  dispute_id: DISPUTE,
  status,
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  dispute_life_cycle_stage: 'INQUIRY',
  dispute_amount: { currency_code: 'USD', value: '42.00' },
  disputed_transactions: [{ seller_transaction_id: CAP, buyer: { name: 'Ada' } }],
  create_time: '2026-11-11T00:00:00Z',
});

describe('dispute_accept guardrails', () => {
  const fs = (disputeStatus: string | null) =>
    computeFactSheet({
      order: normalizeOrder(orderFixture({ id: ORDER, captureId: CAP })),
      targetCaptureId: CAP,
      disputes: disputeStatus ? [{ id: DISPUTE, status: disputeStatus, reason: null, stage: null, amount: null, createdAt: null, updatedAt: null, disputedTransactionIds: [CAP], outcome: null }] : [],
      appRefunds: [],
      locks: [],
    });
  const proposal = { decisionType: 'dispute_accept' as const, type: 'dispute_accept' as const, amount: null, currency: 'USD', captureId: CAP, disputeId: DISPUTE, reason: '', source: 'merchant' as const, summary: '' };
  const judge = { verdict: 'APPROVE' as const, decision: { type: 'dispute_accept' as const, amount: null, currency: null }, rationale: 'r', decisiveArguments: [], rejectedArguments: [], strongestDissent: '', confidence: 0.9, conditions: [] };

  it('approves an open dispute and makes only the dispute executable', () => {
    const g = applyGuardrails({ decisionType: 'dispute_accept', proposal, judge, factSheet: fs('WAITING_FOR_SELLER_RESPONSE') });
    expect(g).toMatchObject({ finalOutcome: 'APPROVE', executableDispute: { disputeId: DISPUTE }, executable: null });
  });
  it('rejects when the dispute is not open (live)', () => {
    expect(applyGuardrails({ decisionType: 'dispute_accept', proposal, judge, factSheet: fs('RESOLVED') })).toMatchObject({ finalOutcome: 'REJECT', executableDispute: null });
  });
  it('rejects when a refund is already in progress (double-loss)', () => {
    const f = { ...fs('OPEN'), appPendingRefund: true };
    expect(applyGuardrails({ decisionType: 'dispute_accept', proposal, judge, factSheet: f }).finalOutcome).toBe('REJECT');
  });
});

describe('dispute accept flow', () => {
  async function setup(accept = vi.fn((_a: Record<string, unknown>) => ({ ok: true }))) {
    let status = 'WAITING_FOR_SELLER_RESPONSE';
    const handlers = {
      get_order: () => orderFixture({ id: ORDER, captureId: CAP }),
      list_transactions: () => ({ transaction_details: [] }),
      list_disputes: () => ({ items: [disputeRaw(status)] }),
      get_dispute: () => disputeRaw(status),
      accept_dispute_claim: (a: Record<string, unknown>) => {
        const r = accept(a);
        status = 'RESOLVED';
        return r;
      },
    };
    const route = (req: { system: string; schemaName: string }) => {
      if (req.schemaName === 'InvestigationPlan') return { needsMoreEvidence: false, toolRequests: [] };
      if (req.schemaName === 'InvestigationReport')
        return { caseSummary: 's', customerComplaint: 'c', transactionStatus: 'COMPLETED', findings: [], likelyRootCause: { description: 'd', confidence: 0.7, supportingEvidenceIds: [], limitations: [] }, alternativeExplanations: [], missingInformation: [], proposedDecision: { type: 'dispute_accept', amount: null, currency: null, reason: 'r' } };
      if (req.system.includes('You are the ADVOCATE')) return { role: 'advocate', position: 'for', thesis: 't', arguments: [{ claim: 'c', kind: 'evidence', evidenceIds: ['EV-001'], factSheetFields: [], weight: 'high' }], strongestPoint: '', saferAlternative: null };
      if (req.system.includes('You are the CHALLENGER')) return { role: 'challenger', position: 'against', thesis: 't', arguments: [{ claim: 'c', kind: 'risk', evidenceIds: ['EV-001'], factSheetFields: [], weight: 'low' }], strongestPoint: '', saferAlternative: null };
      return { verdict: 'APPROVE', decision: { type: 'dispute_accept', amount: null, currency: null }, rationale: 'r', decisiveArguments: [], rejectedArguments: [], strongestDissent: '', confidence: 0.9, conditions: [] };
    };
    const { ai } = fakeAI([route as never]);
    const h = makeHarness(handlers, { ai });
    const inv = await request(h.app).post('/api/investigations').send({ targetId: ORDER, complaint: 'buyer opened a dispute' });
    await h.deps.investigations.settled(inv.body.id);
    const c = await request(h.app).post(`/api/investigations/${inv.body.id}/council`).send({ decisionType: 'dispute_accept', disputeId: DISPUTE });
    await h.deps.council.settled(c.body.deliberationId);
    return { h, invId: inv.body.id as string, delId: c.body.deliberationId as string, accept };
  }

  it('requires the council verdict, the exact confirmation, executes once with a slug note, and verifies with get_dispute', async () => {
    const { h, invId, delId, accept } = await setup();
    const d = (await request(h.app).get(`/api/investigations/${invId}/council/${delId}`)).body;
    expect(d).toMatchObject({ finalOutcome: 'APPROVE', executableDispute: { disputeId: DISPUTE } });
    const bad = await request(h.app).post(`/api/investigations/${invId}/dispute/accept`).send({ deliberationId: delId, disputeId: DISPUTE, confirmationText: 'ok' });
    expect(bad.body.error.code).toBe('CONFIRMATION_MISMATCH');
    const ok = await request(h.app).post(`/api/investigations/${invId}/dispute/accept`).send({ deliberationId: delId, disputeId: DISPUTE, confirmationText: `Accept claim ${DISPUTE}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'completed', paypal_response_summary: expect.stringMatching(/get_dispute now reports RESOLVED/) });
    expect(accept).toHaveBeenCalledTimes(1);
    expect((accept.mock.calls[0] as unknown as [Record<string, string>])[0].note).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
    const again = await request(h.app).post(`/api/investigations/${invId}/dispute/accept`).send({ deliberationId: delId, disputeId: DISPUTE, confirmationText: `Accept claim ${DISPUTE}` });
    expect(again.status).toBe(409);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('a refund-council approval cannot be used to accept a dispute', async () => {
    const { h, invId } = await setup();
    const res = await request(h.app).post(`/api/investigations/${invId}/dispute/accept`).send({ deliberationId: 'del_000000000000', disputeId: DISPUTE, confirmationText: `Accept claim ${DISPUTE}` });
    expect(res.status).toBe(404);
  });

  it('lists disputes and shows detail with redacted buyer data', async () => {
    const { h } = await setup();
    expect((await request(h.app).get('/api/disputes')).body.items[0]).toMatchObject({ id: DISPUTE, status: 'WAITING_FOR_SELLER_RESPONSE' });
    const detail = (await request(h.app).get(`/api/disputes/${DISPUTE}`)).body;
    expect(detail.open).toBe(true);
    expect(JSON.stringify(detail.raw)).not.toContain('Ada');
  });

  it('never treats the buyer transaction ID as a capture (list_disputes omits the seller side)', async () => {
    const { normalizeDispute } = await import('../src/services/paypal/paypal-dispute.service.js');
    expect(normalizeDispute({ dispute_id: 'D1', disputed_transactions: [{ buyer_transaction_id: '7L684321PW4584335' }] }).disputedTransactionIds).toEqual([]);
    expect(normalizeDispute({ dispute_id: 'D1', disputed_transactions: [{ buyer_transaction_id: '7L684321PW4584335', seller_transaction_id: '3UU21036DV699220X' }] }).disputedTransactionIds).toEqual(['3UU21036DV699220X']);
  });

  it('dispute summary key facts must cite real payload fields', () => {
    const paths = fieldPaths(disputeRaw());
    expect(paths.has('dispute_amount.value')).toBe(true);
    expect(paths.has('disputed_transactions[0].seller_transaction_id')).toBe(true);
    expect(paths.has('made_up')).toBe(false);
  });
});

/* -------------------------------- insights -------------------------------- */

describe('insights', () => {
  it('computes metrics from real (mocked) data and strips observations citing unknown metrics', async () => {
    const { ai } = fakeAI([
      {
        headline: 'Small Sandbox sample',
        observations: [
          { text: '3 payments', metrics: ['payments.total'] },
          { text: 'Saved $1M', metrics: ['savings.total'] },
        ],
        caveats: ['Small sample'],
      },
    ]);
    const h = makeHarness({ get_order: () => orderFixture({ id: ORDER, captureId: CAP }), list_transactions: () => ({ transaction_details: [] }), list_disputes: () => ({ items: [] }) }, { ai });
    h.db.prepare('INSERT INTO demo_orders (order_id) VALUES (?)').run(ORDER);
    const m = (await request(h.app).get('/api/insights')).body;
    expect(m.metrics.payments.total).toBe(1);
    expect(m.metrics.capturedVolume).toEqual({ USD: 42 });
    expect(m.metrics.refunds.ratePercentOfCaptured).toEqual({ USD: 0 });
    expect(m.metrics.disputes).toEqual({ total: 0, open: 0 });
    const s = (await request(h.app).post('/api/insights/summary')).body;
    expect(s.observations.map((o: { text: string }) => o.text)).toEqual(['3 payments']);
    expect(s.removedUncited).toBe(1);
    expect(metricKeys({ a: { b: 1 } })).toEqual(new Set(['a', 'a.b']));
  });

  it('counts refunds the app executed and PayPal verified (get_order never lists them)', async () => {
    const h = makeHarness({ get_order: () => orderFixture({ id: ORDER, captureId: CAP }), list_transactions: () => ({ transaction_details: [] }), list_disputes: () => ({ items: [] }) });
    h.db.prepare('INSERT INTO demo_orders (order_id) VALUES (?)').run(ORDER);
    h.db.prepare("INSERT INTO refunds (id, capture_id, paypal_refund_id, amount, currency, status, idempotency_key, executed_at) VALUES ('rf_1', ?, 'R1', '20.00', 'USD', 'completed', 'k', '2026-11-12T06:03:09Z')").run(CAP);
    const k = (await request(h.app).get('/api/dashboard/summary')).body.kpis;
    expect(k.refunds).toMatchObject({ count: 1, amount: { USD: 20 } });
  });
});

/* -------------------------------- demo mode -------------------------------- */

describe('Demo mode (no PayPal credentials)', () => {
  function demoApp() {
    const cfg = testConfig({ PAYPAL_ACCESS_TOKEN: '' });
    const db = openDatabase(':memory:');
    const registry = new PayPalToolRegistry(new FakeTransport(), null);
    const paypal = { auth: new PayPalAuth(cfg), mcp: null, registry, transactions: new PayPalTransactionService(registry), refunds: new PayPalRefundService(registry), disputes: new PayPalDisputeService(registry), start: async () => {}, shutdown: async () => {} };
    return createApp(buildDeps(cfg, db, paypal, new StructuredAI(null, null)));
  }

  it('shows clearly labelled sample data and flags demo mode everywhere', async () => {
    const app = demoApp();
    const list = (await request(app).get('/api/transactions')).body;
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((t: { source: string; captureId: string }) => t.source === 'demo_sample' && t.captureId.startsWith('DEMO-'))).toBe(true);
    expect(list.sources.demoMode).toMatchObject({ active: true });
    expect((await request(app).get('/api/dashboard/summary')).body.dataMode).toBe('demo');
    expect((await request(app).get('/api/settings/integration-status')).body.demoMode).toMatchObject({ active: true });
  });

  it('refuses investigations (and therefore councils and refunds) in demo mode', async () => {
    const app = demoApp();
    const res = await request(app).post('/api/investigations').send({ targetId: 'DEMO-CAPTURE-0001', complaint: 'test complaint' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEMO_MODE');
  });

  it('never calls PayPal for a demo ID', async () => {
    const h = makeHarness({ get_order: () => { throw new PayPalError('should not be called', 500, 'X'); } });
    const res = await request(h.app).post('/api/investigations').send({ targetId: 'DEMO-CAPTURE-0001', complaint: 'test complaint' });
    expect(res.status).toBe(409);
    expect(h.transport.calls).toHaveLength(0);
  });
});
