import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = z.preprocess(blankToUndefined, z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: optStr,
  PAYPAL_ENVIRONMENT: z.preprocess(blankToUndefined, z.string().default('SANDBOX')),
  PAYPAL_CLIENT_ID: optStr,
  PAYPAL_CLIENT_SECRET: optStr,
  PAYPAL_ACCESS_TOKEN: optStr,
  PAYPAL_WEBHOOK_ID: optStr,
  AI_PROVIDER: z.preprocess(blankToUndefined, z.enum(['anthropic', 'gemini', 'openai']).default('anthropic')),
  ANTHROPIC_API_KEY: optStr,
  GEMINI_API_KEY: optStr,
  OPENAI_API_KEY: optStr,
  OPENAI_BASE_URL: optStr,
  AI_MODEL_INVESTIGATOR: optStr,
  AI_MODEL_ADVOCATE: optStr,
  AI_MODEL_CHALLENGER: optStr,
  AI_MODEL_JUDGE: optStr,
  AI_MODEL_FALLBACK: optStr,
  COUNCIL_REBUTTAL: z.preprocess(blankToUndefined, z.string().default('false')).transform((v) => v === 'true'),
  DATABASE_PATH: z.preprocess(blankToUndefined, z.string().default('./data/refund-detective.db')),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().default(3001)),
  LOG_LEVEL: z.preprocess(blankToUndefined, z.string().default('info')),
});

type Parsed = z.infer<typeof EnvSchema>;
type ModelKeys = 'AI_MODEL_INVESTIGATOR' | 'AI_MODEL_ADVOCATE' | 'AI_MODEL_CHALLENGER' | 'AI_MODEL_JUDGE';
export type AppConfig = Omit<Parsed, ModelKeys | 'AI_MODEL_FALLBACK'> & Record<ModelKeys, string> & { AI_MODEL_FALLBACK: string | null; AI_FALLBACKS: Record<'investigator' | 'advocate' | 'challenger' | 'judge', string | null>; PAYPAL_API_BASE: string; AI_BASE_URL: string | null; AI_API_KEY: string | null };

/** Per-provider defaults. Every value is overridable via env. */
export const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: null, investigator: 'claude-sonnet-5-5', advocate: 'claude-sonnet-5-5', challenger: 'claude-sonnet-5-5', judge: 'claude-opus-5-5', fallbacks: { investigator: null, advocate: null, challenger: null, judge: null } },
  // Gemini via Google's OpenAI-compatible endpoint. Model ids are verified against the live /models list at setup.
  // Chosen from a live probe on 2026-11-12 (free tier): 2.5-* return 404 for new keys; Pro/4-* have no free quota.
  // Advocate and Challenger use different models to decorrelate their reasoning and split per-model rate limits.
  // Free-tier quotas are per model, so each role has its own fallback and the two parallel agents never share one
  // (a shared fallback made both hit one throttled model; seen live). Lite models verified with free quota.
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    investigator: 'gemini-3.5-flash',
    advocate: 'gemini-3.5-flash',
    challenger: 'gemini-3-flash-preview',
    judge: 'gemini-3.6-flash',
    fallbacks: { investigator: 'gemini-3.5-flash-lite', advocate: 'gemini-3.1-flash-lite', challenger: 'gemini-3.5-flash-lite', judge: 'gemini-3-flash-preview' },
  },
  openai: { baseUrl: null, investigator: '', advocate: '', challenger: '', judge: '', fallbacks: { investigator: null, advocate: null, challenger: null, judge: null } },
} as const;

export class SandboxOnlyError extends Error {}

/** Parses env and enforces the Sandbox-only rule. The app never talks to Live. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  if (parsed.PAYPAL_ENVIRONMENT.toUpperCase() !== 'SANDBOX') {
    throw new SandboxOnlyError(
      `Refusing to boot: PAYPAL_ENVIRONMENT must be SANDBOX (got "${parsed.PAYPAL_ENVIRONMENT}"). Refund Detective never runs against Live.`,
    );
  }
  // Relative DB paths resolve from the repo root (server/src and server/dist are both two levels down),
  // so `npm run dev`, `npm start` and scripts all share one database regardless of cwd.
  const dbPath =
    parsed.DATABASE_PATH === ':memory:' || path.isAbsolute(parsed.DATABASE_PATH)
      ? parsed.DATABASE_PATH
      : path.resolve(REPO_ROOT, parsed.DATABASE_PATH);
  const d = PROVIDER_DEFAULTS[parsed.AI_PROVIDER];
  const AI_API_KEY = (parsed.AI_PROVIDER === 'anthropic' ? parsed.ANTHROPIC_API_KEY : parsed.AI_PROVIDER === 'gemini' ? parsed.GEMINI_API_KEY : parsed.OPENAI_API_KEY) ?? null;
  return {
    ...parsed,
    AI_MODEL_INVESTIGATOR: parsed.AI_MODEL_INVESTIGATOR ?? d.investigator,
    AI_MODEL_ADVOCATE: parsed.AI_MODEL_ADVOCATE ?? d.advocate,
    AI_MODEL_CHALLENGER: parsed.AI_MODEL_CHALLENGER ?? d.challenger,
    AI_MODEL_JUDGE: parsed.AI_MODEL_JUDGE ?? d.judge,
    AI_MODEL_FALLBACK: parsed.AI_MODEL_FALLBACK ?? null,
    // AI_MODEL_FALLBACK (if set) overrides every role's fallback.
    AI_FALLBACKS: parsed.AI_MODEL_FALLBACK
      ? { investigator: parsed.AI_MODEL_FALLBACK, advocate: parsed.AI_MODEL_FALLBACK, challenger: parsed.AI_MODEL_FALLBACK, judge: parsed.AI_MODEL_FALLBACK }
      : { ...d.fallbacks },
    AI_BASE_URL: parsed.OPENAI_BASE_URL ?? d.baseUrl,
    AI_API_KEY,
    DATABASE_PATH: dbPath,
    PAYPAL_ENVIRONMENT: 'SANDBOX',
    PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  };
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
