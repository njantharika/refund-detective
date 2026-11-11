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
  AI_PROVIDER: z.preprocess(blankToUndefined, z.enum(['anthropic', 'openai']).default('anthropic')),
  ANTHROPIC_API_KEY: optStr,
  OPENAI_API_KEY: optStr,
  OPENAI_BASE_URL: optStr,
  AI_MODEL_INVESTIGATOR: z.preprocess(blankToUndefined, z.string().default('claude-sonnet-5-5')),
  AI_MODEL_ADVOCATE: z.preprocess(blankToUndefined, z.string().default('claude-sonnet-5-5')),
  AI_MODEL_CHALLENGER: z.preprocess(blankToUndefined, z.string().default('claude-sonnet-5-5')),
  AI_MODEL_JUDGE: z.preprocess(blankToUndefined, z.string().default('claude-opus-5-5')),
  COUNCIL_REBUTTAL: z.preprocess(blankToUndefined, z.string().default('false')).transform((v) => v === 'true'),
  DATABASE_PATH: z.preprocess(blankToUndefined, z.string().default('./data/refund-detective.db')),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().default(3001)),
  LOG_LEVEL: z.preprocess(blankToUndefined, z.string().default('info')),
});

export type AppConfig = z.infer<typeof EnvSchema> & { PAYPAL_API_BASE: string };

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
  return { ...parsed, DATABASE_PATH: dbPath, PAYPAL_ENVIRONMENT: 'SANDBOX', PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' };
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
