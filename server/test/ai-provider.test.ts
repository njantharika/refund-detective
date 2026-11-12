import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AIError, OpenAICompatibleTransport, StructuredAI, extractJson, toProviderJsonSchema } from '../src/ai/provider.js';
import { fakeAI, httpErr } from './helpers.js';

const Schema = z.object({ verdict: z.enum(['APPROVE', 'REJECT']), confidence: z.number().min(0).max(1) });
const args = { system: 's', messages: [{ role: 'user' as const, content: 'q' }], schema: Schema, schemaName: 'V', model: 'm1', timeoutMs: 5000 };

describe('StructuredAI', () => {
  it('returns Zod-validated JSON', async () => {
    const { ai } = fakeAI([{ verdict: 'REJECT', confidence: 0.9 }]);
    const r = await ai.complete(args);
    expect(r.data).toEqual({ verdict: 'REJECT', confidence: 0.9 });
    expect(r.validationRetried).toBe(false);
  });

  it('retries exactly once with the validation error, then succeeds', async () => {
    const { ai, transport } = fakeAI([{ verdict: 'MAYBE', confidence: 2 }, { verdict: 'APPROVE', confidence: 0.7 }]);
    const r = await ai.complete(args);
    expect(r.data.verdict).toBe('APPROVE');
    expect(r.validationRetried).toBe(true);
    const last = transport.requests[1].messages.at(-1)!.content;
    expect(last).toMatch(/failed validation/);
    expect(last).toMatch(/verdict/);
  });

  it('fails visibly after a second invalid output', async () => {
    const { ai } = fakeAI(['not json at all', '{"verdict":"MAYBE"}']);
    await expect(ai.complete(args)).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
  });

  it('retries 429 with backoff and reports it via onRetry', async () => {
    const { ai, transport } = fakeAI([httpErr(429), { verdict: 'REJECT', confidence: 1 }]);
    const onRetry = vi.fn();
    const r = await ai.complete({ ...args, onRetry });
    expect(r.data.verdict).toBe('REJECT');
    expect(transport.requests).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rate_limited' }));
  });

  it('switches to the fallback model immediately on 429/503 (per-model quotas)', async () => {
    const { ai, transport } = fakeAI([httpErr(429), { verdict: 'APPROVE', confidence: 0.8 }], 'fallback-model');
    const r = await ai.complete(args);
    expect(r.model).toBe('fallback-model');
    expect(transport.requests.map((q) => q.model)).toEqual(['m1', 'fallback-model']);
  });

  it('a hung attempt times out early so the fallback still gets a chance', async () => {
    const t = { name: 'hang', calls: [] as string[], async call(req: { model: string; signal: AbortSignal }) {
      this.calls.push(req.model);
      if (req.model === 'm1') return new Promise<string>((_, rej) => req.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
      return '{"verdict":"REJECT","confidence":1}';
    } };
    const ai = new StructuredAI(t as never, null, { baseBackoffMs: 1 });
    const r = await ai.complete({ ...args, timeoutMs: 20_000, fallbackModel: 'fb' });
    expect(t.calls).toEqual(['m1', 'fb']);
    expect(r.model).toBe('fb');
  }, 20_000);

  it('per-call fallbackModel overrides the provider default', async () => {
    const { ai, transport } = fakeAI([httpErr(429), { verdict: 'APPROVE', confidence: 0.8 }], 'default-fb');
    await ai.complete({ ...args, fallbackModel: 'role-fb' });
    expect(transport.requests.map((q) => q.model)).toEqual(['m1', 'role-fb']);
  });

  it('returns to the primary model with backoff when the fallback is also throttled', async () => {
    const { ai, transport } = fakeAI([httpErr(503), httpErr(503), { verdict: 'APPROVE', confidence: 0.8 }], 'fallback-model');
    const r = await ai.complete(args);
    expect(r.model).toBe('m1');
    expect(transport.requests.map((q) => q.model)).toEqual(['m1', 'fallback-model', 'm1']);
  });

  it('surfaces rate limiting when every attempt is 429', async () => {
    const { ai } = fakeAI([httpErr(429)]);
    await expect(ai.complete(args)).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
  });

  it('does not retry non-retryable errors', async () => {
    const { ai, transport } = fakeAI([httpErr(400)]);
    await expect(ai.complete(args)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
    expect(transport.requests).toHaveLength(1);
  });

  it('reports AI not configured instead of substituting anything', async () => {
    await expect(new StructuredAI(null, null).complete(args)).rejects.toBeInstanceOf(AIError);
    expect(new StructuredAI(null, null).configured).toBe(false);
  });
});

describe('helpers', () => {
  it('extracts JSON from fenced output', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2}')).toEqual({ a: 2 });
  });
  it('produces a provider-friendly JSON schema', () => {
    const js = toProviderJsonSchema(Schema);
    expect(js).not.toHaveProperty('$schema');
    expect(JSON.stringify(js)).not.toContain('additionalProperties');
    const lengths = toProviderJsonSchema(z.object({ s: z.string().max(5), a: z.array(z.string()).min(1).max(3) }));
    expect(JSON.stringify(lengths)).not.toMatch(/maxLength|minLength|maxItems|minItems/);
    expect((js.properties as Record<string, unknown>).verdict).toMatchObject({ enum: ['APPROVE', 'REJECT'] });
  });
});

describe('OpenAICompatibleTransport', () => {
  it('posts a json_schema response_format and parses the completion', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
    const t = new OpenAICompatibleTransport('gemini', 'https://example.test/v1beta/openai/', 'KEY', fetchMock as unknown as typeof fetch);
    const out = await t.call({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], jsonSchema: { type: 'object' }, schemaName: 'X', model: 'gemini-x', signal: AbortSignal.timeout(1000) });
    expect(out).toBe('{"ok":true}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://example.test/v1beta/openai/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'X', schema: { type: 'object' } } });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('parses Gemini retryDelay on 429', async () => {
    const fetchMock = vi.fn(async () => new Response('[{"error":{"code":429,"message":"quota","details":[{"retryDelay":"7s"}]}}]', { status: 429 }));
    const t = new OpenAICompatibleTransport('gemini', 'https://example.test/', 'KEY', fetchMock as unknown as typeof fetch);
    await expect(t.call({ system: '', messages: [], jsonSchema: {}, schemaName: 'X', model: 'm', signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ status: 429, retryAfterMs: 7000, message: 'quota' });
  });
});
