import pino from 'pino';

/** Paths redacted from every log line. Payloads are never logged on purpose; this is defence in depth. */
export const REDACT_PATHS = [
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
  'access_token',
  '*.access_token',
  'client_secret',
  '*.client_secret',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refresh_token',
  '*.refresh_token',
  'PAYPAL_ACCESS_TOKEN',
  'PAYPAL_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'apiKey',
  '*.apiKey',
];

const TOKEN_LIKE = /(A21AA[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

/** Scrubs token-shaped substrings from free text (for error messages that may echo headers). */
export function scrubSecrets(text: string): string {
  return text.replace(TOKEN_LIKE, '[REDACTED]');
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(process.env.NODE_ENV !== 'production' && process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
