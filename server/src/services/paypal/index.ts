import type { AppConfig } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { PayPalAuth } from './paypal-auth.js';
import { PayPalMcpClient, type ToolTransport } from './paypal-mcp-client.js';
import { PayPalRestFallback } from './paypal-rest-fallback.js';
import { PayPalToolRegistry } from './paypal-tool-registry.js';
import { PayPalTransactionService } from './paypal-transaction.service.js';
import { PayPalRefundService } from './paypal-refund.service.js';
import { PayPalDisputeService } from './paypal-dispute.service.js';

export interface PayPalIntegration {
  auth: PayPalAuth;
  mcp: (ToolTransport & { status(): ReturnType<PayPalMcpClient['status']>; shutdown(): Promise<void> }) | null;
  registry: PayPalToolRegistry;
  transactions: PayPalTransactionService;
  refunds: PayPalRefundService;
  disputes: PayPalDisputeService;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createPayPalIntegration(cfg: AppConfig): PayPalIntegration {
  const auth = new PayPalAuth(cfg);
  const mcp = new PayPalMcpClient();
  const fallback = new PayPalRestFallback(auth);
  // The MCP child receives its token via env at spawn, so a new token means a child restart.
  // syncChild() is idempotent and shared, so concurrent callers wait for one restart.
  let syncing: Promise<void> | null = null;
  const syncChild = (token: string): Promise<void> => {
    if (mcp.status().state === 'stopped' || mcp.currentToken() === token) return Promise.resolve();
    syncing ??= mcp
      .updateToken(token)
      .then(() => registry.refreshSchemas())
      .catch((e) => logger.error({ err: String(e) }, 'mcp restart after token refresh failed'))
      .finally(() => (syncing = null));
    return syncing;
  };
  const tokenGuard = {
    async ensureFresh() {
      if (auth.mode !== 'client_credentials') return;
      if (auth.isStale()) await syncChild(await auth.getToken());
      else if (syncing) await syncing;
    },
    async recoverFromAuthError() {
      if (auth.mode !== 'client_credentials') return false;
      logger.warn('PayPal rejected the access token (401); minting a new one and restarting the MCP child');
      auth.invalidate();
      try {
        await syncChild(await auth.getToken());
        return true;
      } catch {
        return false;
      }
    },
  };
  const registry: PayPalToolRegistry = new PayPalToolRegistry(mcp, fallback, tokenGuard);

  // Background refreshes also restart the child proactively.
  auth.on('token', (token: string) => void syncChild(token));

  return {
    auth,
    mcp,
    registry,
    transactions: new PayPalTransactionService(registry),
    refunds: new PayPalRefundService(registry),
    disputes: new PayPalDisputeService(registry),
    async start() {
      if (auth.mode === 'none') {
        logger.warn('No PayPal credentials: MCP client not started');
        return;
      }
      try {
        const token = await auth.getToken();
        await mcp.start(token);
        await registry.refreshSchemas();
        const missing = registry.missingAllowedTools();
        if (missing.length) logger.warn({ missing }, 'MCP server did not advertise some allowlisted tools');
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, 'PayPal integration start failed; REST fallback will serve reads');
      }
    },
    async shutdown() {
      auth.stop();
      await mcp.shutdown();
    },
  };
}
