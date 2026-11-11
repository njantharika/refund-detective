import { EventEmitter } from 'node:events';
import type { AppConfig } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { PayPalError } from './paypal.types.js';

export type AuthMode = 'client_credentials' | 'static_token' | 'none';

export interface AuthStatus {
  mode: AuthMode;
  hasToken: boolean;
  expiresAt: string | null; // null when unknown (static token)
  warning: string | null;
  lastError: string | null;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Supplies Sandbox access tokens. With client credentials it mints and refreshes tokens itself
 * (emitting "token" on each new one so the MCP child can be restarted). With only a static
 * PAYPAL_ACCESS_TOKEN it uses that and warns that it will expire.
 */
export class PayPalAuth extends EventEmitter {
  private token: string | null = null;
  private expiresAtMs: number | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<string> | null = null;
  private lastError: string | null = null;
  readonly mode: AuthMode;

  constructor(
    private readonly cfg: Pick<AppConfig, 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET' | 'PAYPAL_ACCESS_TOKEN' | 'PAYPAL_API_BASE'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    if (cfg.PAYPAL_CLIENT_ID && cfg.PAYPAL_CLIENT_SECRET) this.mode = 'client_credentials';
    else if (cfg.PAYPAL_ACCESS_TOKEN) this.mode = 'static_token';
    else this.mode = 'none';
    if (this.mode === 'static_token') this.token = cfg.PAYPAL_ACCESS_TOKEN!;
  }

  async getToken(): Promise<string> {
    if (this.mode === 'none') throw new PayPalError('No PayPal credentials configured', null, 'NO_CREDENTIALS');
    if (this.mode === 'static_token') return this.token!;
    if (this.token && this.expiresAtMs && Date.now() < this.expiresAtMs - REFRESH_MARGIN_MS) return this.token;
    return this.mint();
  }

  private mint(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const basic = Buffer.from(`${this.cfg.PAYPAL_CLIENT_ID}:${this.cfg.PAYPAL_CLIENT_SECRET}`).toString('base64');
        const res = await this.fetchImpl(`${this.cfg.PAYPAL_API_BASE}/v1/oauth2/token`, {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new PayPalError(`OAuth token request failed (HTTP ${res.status})`, res.status, 'OAUTH_FAILED');
        const body = (await res.json()) as { access_token: string; expires_in: number };
        this.token = body.access_token;
        this.expiresAtMs = Date.now() + body.expires_in * 1000;
        this.lastError = null;
        this.scheduleRefresh();
        logger.info({ expiresInSec: body.expires_in }, 'paypal oauth token minted');
        this.emit('token', this.token);
        return this.token;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.expiresAtMs) return;
    const delay = Math.max(30_000, this.expiresAtMs - REFRESH_MARGIN_MS - Date.now());
    this.refreshTimer = setTimeout(() => {
      this.mint().catch((e) => logger.warn({ err: String(e) }, 'scheduled token refresh failed'));
    }, delay);
    this.refreshTimer.unref();
  }

  status(): AuthStatus {
    return {
      mode: this.mode,
      hasToken: Boolean(this.token),
      expiresAt: this.expiresAtMs ? new Date(this.expiresAtMs).toISOString() : null,
      warning:
        this.mode === 'static_token'
          ? 'Using a static PAYPAL_ACCESS_TOKEN: token expires; add client credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) for automatic refresh.'
          : this.mode === 'none'
            ? 'No PayPal credentials configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.'
            : null,
      lastError: this.lastError,
    };
  }

  stop() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}
