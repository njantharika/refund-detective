import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { logger, scrubSecrets } from '../lib/logger.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export interface CompleteArgs<T> {
  system: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  model: string;
  timeoutMs: number;
  /** Per-call fallback model (overrides the provider default; null disables fallback). */
  fallbackModel?: string | null;
  /** Called on each retry so the UI can show "waiting for rate limit" honestly. */
  onRetry?: (info: { reason: string; attempt: number; waitMs: number; model: string }) => void;
}

export interface CompleteResult<T> {
  data: T;
  model: string; // the model that actually produced the output (may be the fallback)
  attempts: number;
  validationRetried: boolean;
  durationMs: number;
}

export class AIError extends Error {
  constructor(
    public code: 'AI_NOT_CONFIGURED' | 'AI_TIMEOUT' | 'AI_RATE_LIMITED' | 'AI_UNAVAILABLE' | 'AI_INVALID_OUTPUT' | 'AI_REQUEST_FAILED',
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Low-level transport: one model call returning raw text. Adapters implement this. */
export interface RawTransport {
  readonly name: string;
  call(req: { system: string; messages: ChatMessage[]; jsonSchema: Record<string, unknown>; schemaName: string; model: string; signal: AbortSignal }): Promise<string>;
}

export class TransportHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/**
 * JSON Schema from Zod, trimmed to the subset Gemini's OpenAI-compatible structured output accepts.
 * Verified live 2026-11-12: Gemini returns 400 INVALID_ARGUMENT for maxLength/minLength/maxItems/minItems,
 * so those are stripped here. Zod still enforces every limit on the response.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', '$id', 'additionalProperties', 'maxLength', 'minLength', 'maxItems', 'minItems']);

export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = strip(v);
    }
    return out;
  };
  return strip(js) as Record<string, unknown>;
}

export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // Tolerate ```json fences or leading prose; take the outermost object.
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
    return JSON.parse(candidate);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AIProvider {
  readonly name: string;
  readonly configured: boolean;
  complete<T>(args: CompleteArgs<T>): Promise<CompleteResult<T>>;
}

/**
 * Provider-agnostic structured completion:
 *  - transport errors 429/5xx: up to 2 backoff retries, then one try on the fallback model
 *  - invalid JSON / schema mismatch: exactly one retry with the validation error, then AI_INVALID_OUTPUT
 *  - hard wall-clock budget via timeoutMs
 */
export class StructuredAI implements AIProvider {
  constructor(
    private readonly transport: RawTransport | null,
    private readonly fallbackModel: string | null,
    private readonly opts: { baseBackoffMs?: number } = {},
  ) {}

  get name() {
    return this.transport?.name ?? 'none';
  }
  get configured() {
    return this.transport !== null;
  }

  async complete<T>(args: CompleteArgs<T>): Promise<CompleteResult<T>> {
    if (!this.transport) throw new AIError('AI_NOT_CONFIGURED', 'AI not configured');
    const started = Date.now();
    const deadline = started + args.timeoutMs;
    const jsonSchema = toProviderJsonSchema(args.schema);
    const system = `${args.system}\n\nRespond with a single JSON object that matches the "${args.schemaName}" schema. No prose, no markdown fences.`;
    let messages = [...args.messages];
    let attempts = 0;
    let validationRetried = false;

    for (;;) {
      const { text, model } = await this.callWithRetries({ ...args, system, messages, jsonSchema, deadline, fallback: args.fallbackModel === undefined ? this.fallbackModel : args.fallbackModel }, () => attempts++);
      let parsed: unknown;
      let problem: string | null = null;
      try {
        parsed = extractJson(text);
        const r = args.schema.safeParse(parsed);
        if (r.success) {
          logger.info({ schema: args.schemaName, model, attempts, durationMs: Date.now() - started }, 'ai completion ok');
          return { data: r.data, model, attempts, validationRetried, durationMs: Date.now() - started };
        }
        problem = r.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
      } catch (e) {
        problem = `Output was not valid JSON (${e instanceof Error ? e.message : String(e)})`;
      }
      if (validationRetried) {
        throw new AIError('AI_INVALID_OUTPUT', `Model output failed ${args.schemaName} validation after one retry: ${problem}`, { problem });
      }
      validationRetried = true;
      logger.warn({ schema: args.schemaName, problem }, 'ai output invalid; retrying once');
      messages = [
        ...messages,
        { role: 'assistant', content: text.slice(0, 8000) },
        { role: 'user', content: `Your previous response failed validation: ${problem}. Return a corrected JSON object only.` },
      ];
    }
  }

  private async callWithRetries(
    a: { system: string; messages: ChatMessage[]; jsonSchema: Record<string, unknown>; schemaName: string; model: string; deadline: number; timeoutMs: number; fallback: string | null; onRetry?: CompleteArgs<unknown>['onRetry'] },
    countAttempt: () => void,
  ): Promise<{ text: string; model: string }> {
    const base = this.opts.baseBackoffMs ?? 2000;
    // Gemini free-tier quotas are per model, so on 429/5xx switch to the fallback model at once (no wait),
    // and only wait (honouring retryDelay) when going back to a model that was throttled.
    const fallback = a.fallback && a.fallback !== a.model ? a.fallback : null;
    // A single hung attempt must not consume the whole budget, or no fallback is ever tried (seen live).
    const attemptCap = fallback ? Math.max(10_000, Math.round(a.timeoutMs * 0.6)) : a.timeoutMs;
    const MAX_ATTEMPTS = 4;
    let model = a.model;
    let fallbackTried = false;
    let sameModelRetries = 0;
    let last: unknown;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const remaining = a.deadline - Date.now();
      if (remaining <= 500) break;
      countAttempt();
      try {
        const text = await this.transport!.call({ system: a.system, messages: a.messages, jsonSchema: a.jsonSchema, schemaName: a.schemaName, model, signal: AbortSignal.timeout(Math.min(remaining, attemptCap)) });
        return { text, model };
      } catch (e) {
        last = e;
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        const retryable = (e instanceof TransportHttpError && RETRYABLE.has(e.status)) || (timedOut && !!fallback && !fallbackTried);
        if (!retryable || i === MAX_ATTEMPTS - 1) break;
        let next: string;
        let wait: number;
        if (fallback && !fallbackTried) {
          next = fallback;
          fallbackTried = true;
          wait = 0;
        } else {
          next = a.model;
          wait = Math.min((e instanceof TransportHttpError ? e.retryAfterMs : null) ?? base * 2 ** sameModelRetries, 20_000);
          sameModelRetries++;
        }
        if (Date.now() + wait >= a.deadline - 500) break;
        const status = e instanceof TransportHttpError ? e.status : 'timeout';
        a.onRetry?.({ reason: status === 429 ? 'rate_limited' : 'model_unavailable', attempt: i + 1, waitMs: wait, model: next });
        logger.warn({ status, model, next, waitMs: wait }, 'ai transport retry');
        if (wait) await sleep(wait);
        model = next;
      }
    }
    if (last instanceof TransportHttpError) {
      if (last.status === 429) throw new AIError('AI_RATE_LIMITED', `AI provider rate limit reached: ${last.message}`);
      if (last.status >= 500) throw new AIError('AI_UNAVAILABLE', `AI model unavailable: ${last.message}`);
      throw new AIError('AI_REQUEST_FAILED', `AI request failed (HTTP ${last.status}): ${last.message}`);
    }
    const msg = last instanceof Error ? last.message : String(last ?? 'time budget exhausted');
    if (/abort|timeout/i.test(msg) || !last) throw new AIError('AI_TIMEOUT', 'AI call exceeded its time budget');
    throw new AIError('AI_REQUEST_FAILED', scrubSecrets(msg));
  }
}

/* --------------------------------- adapters -------------------------------- */

function parseRetryAfter(res: Response, body: string): number | null {
  const h = res.headers.get('retry-after');
  if (h && /^\d+$/.test(h)) return Number(h) * 1000;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

/** OpenAI-compatible chat completions with JSON-schema structured output (Gemini, OpenAI, and others). */
export class OpenAICompatibleTransport implements RawTransport {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(req: Parameters<RawTransport['call']>[0]): Promise<string> {
    const res = await this.fetchImpl(new URL('chat/completions', this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.jsonSchema } },
        temperature: 0.2,
      }),
      signal: req.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body.slice(0, 300);
      try {
        const j = JSON.parse(body);
        message = (Array.isArray(j) ? j[0] : j)?.error?.message ?? message;
      } catch {
        /* keep raw */
      }
      throw new TransportHttpError(res.status, scrubSecrets(message), parseRetryAfter(res, body));
    }
    const j = JSON.parse(body) as { choices?: { message?: { content?: string | null } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (!content) throw new TransportHttpError(502, 'Empty completion from AI provider', null);
    return content;
  }
}

/** Anthropic Messages API adapter (kept so the provider can be swapped back via AI_PROVIDER=anthropic). */
export class AnthropicTransport implements RawTransport {
  readonly name = 'anthropic';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(req: Parameters<RawTransport['call']>[0]): Promise<string> {
    const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        max_tokens: 4096,
        system: `${req.system}\n\nJSON schema:\n${JSON.stringify(req.jsonSchema)}`,
        messages: req.messages,
      }),
      signal: req.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new TransportHttpError(res.status, scrubSecrets(body.slice(0, 300)), parseRetryAfter(res, body));
    const j = JSON.parse(body) as { content?: { type: string; text?: string }[] };
    const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text) throw new TransportHttpError(502, 'Empty completion from AI provider', null);
    return text;
  }
}

export function createAI(cfg: AppConfig): StructuredAI {
  if (!cfg.AI_API_KEY) return new StructuredAI(null, null);
  if (cfg.AI_PROVIDER === 'anthropic') return new StructuredAI(new AnthropicTransport(cfg.AI_API_KEY), null);
  if (!cfg.AI_BASE_URL) return new StructuredAI(null, null);
  return new StructuredAI(new OpenAICompatibleTransport(cfg.AI_PROVIDER, cfg.AI_BASE_URL, cfg.AI_API_KEY), null);
}

export function modelFor(cfg: AppConfig, role: 'investigator' | 'advocate' | 'challenger' | 'judge'): string {
  return { investigator: cfg.AI_MODEL_INVESTIGATOR, advocate: cfg.AI_MODEL_ADVOCATE, challenger: cfg.AI_MODEL_CHALLENGER, judge: cfg.AI_MODEL_JUDGE }[role];
}

export function fallbackFor(cfg: AppConfig, role: 'investigator' | 'advocate' | 'challenger' | 'judge'): string | null {
  return cfg.AI_FALLBACKS[role];
}
