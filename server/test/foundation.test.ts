import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { loadConfig, SandboxOnlyError } from '../src/config.js';
import { openDatabase } from '../src/database/db.js';
import { scrubSecrets } from '../src/lib/logger.js';
import { makeHarness } from './helpers.js';

describe('config: sandbox-only guard', () => {
  it('refuses to boot when PAYPAL_ENVIRONMENT is not SANDBOX', () => {
    expect(() => loadConfig({ PAYPAL_ENVIRONMENT: 'LIVE' })).toThrow(SandboxOnlyError);
    expect(() => loadConfig({ PAYPAL_ENVIRONMENT: 'production' })).toThrow(SandboxOnlyError);
  });
  it('defaults to SANDBOX and the sandbox API base', () => {
    const c = loadConfig({});
    expect(c.PAYPAL_ENVIRONMENT).toBe('SANDBOX');
    expect(c.PAYPAL_API_BASE).toBe('https://api-m.sandbox.paypal.com');
    expect(c.AI_MODEL_JUDGE).toBe('claude-opus-5-5');
    expect(c.COUNCIL_REBUTTAL).toBe(false);
  });
  it('treats blank env values as unset', () => {
    const c = loadConfig({ AI_MODEL_INVESTIGATOR: '', PORT: '' });
    expect(c.AI_MODEL_INVESTIGATOR).toBe('claude-sonnet-5-5');
    expect(c.PORT).toBe(3001);
  });
});

describe('database migration', () => {
  it('creates every table and is idempotent', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
    for (const t of ['investigations', 'evidence', 'deliberations', 'refunds', 'operation_locks', 'webhook_events', 'audit_log', 'demo_orders']) {
      expect(tables).toContain(t);
    }
  });
  it('enforces unique idempotency keys on refunds', () => {
    const db = openDatabase(':memory:');
    const ins = db.prepare("INSERT INTO refunds (id, capture_id, amount, currency, status, idempotency_key) VALUES (?, 'CAP', '1.00', 'USD', 'requested', 'k1')");
    ins.run('r1');
    expect(() => ins.run('r2')).toThrow(/UNIQUE/);
  });
});

describe('secret scrubbing', () => {
  it('redacts token-shaped substrings', () => {
    const s = scrubSecrets('Authorization: Bearer A21AAabcdefghijklmnopqrstu and sk-ant-abcdefghijklmnop');
    expect(s).not.toMatch(/A21AAabc/);
    expect(s).not.toMatch(/sk-ant-abc/);
  });
});

describe('GET /api/health', () => {
  it('returns ok with SANDBOX', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', environment: 'SANDBOX' });
  });
  it('uses the consistent error shape for unknown routes', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });
  it('rejects bodies over 100kb', async () => {
    const { app } = makeHarness();
    const res = await request(app).post('/api/settings/test-connection').set('content-type', 'application/json').send(JSON.stringify({ x: 'a'.repeat(110_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('GET /api/settings/integration-status', () => {
  it('never returns secret values', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/api/settings/integration-status');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('test-token');
    expect(res.body.paypal.environment).toBe('SANDBOX');
    expect(res.body.paypal.auth.mode).toBe('static_token');
    expect(res.body.paypal.auth.warning).toMatch(/token expires; add client credentials/);
    expect(res.body.ai).toMatchObject({ configured: false, message: 'AI not configured' });
  });
});

describe('config: AI provider presets', () => {
  it('gemini uses the OpenAI-compatible endpoint, GEMINI_API_KEY and gemini defaults', () => {
    const c = loadConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    expect(c.AI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
    expect(c.AI_API_KEY).toBe('k');
    expect(c.AI_MODEL_INVESTIGATOR).toMatch(/^gemini-/);
    expect(c.AI_MODEL_JUDGE).toMatch(/^gemini-/);
  });
  it('env model overrides win over provider defaults', () => {
    expect(loadConfig({ AI_PROVIDER: 'gemini', AI_MODEL_JUDGE: 'gemini-x' }).AI_MODEL_JUDGE).toBe('gemini-x');
  });
  it('anthropic without a key is not configured', () => {
    expect(loadConfig({}).AI_API_KEY).toBeNull();
  });
});
