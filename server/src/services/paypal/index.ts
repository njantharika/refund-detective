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
  const registry = new PayPalToolRegistry(mcp, fallback);

  // Each newly minted token restarts the MCP child so it never runs with an expired token.
  auth.on('token', (token: string) => {
    if (mcp.status().state === 'stopped') return;
    mcp
      .updateToken(token)
      .then(() => registry.refreshSchemas())
      .catch((e) => logger.error({ err: String(e) }, 'mcp restart after token refresh failed'));
  });

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
