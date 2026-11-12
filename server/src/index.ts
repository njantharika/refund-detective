import { loadConfig, SandboxOnlyError } from './config.js';
import { openDatabase } from './database/db.js';
import { logger } from './lib/logger.js';
import path from 'node:path';
import { REPO_ROOT } from './config.js';
import { importSnapshotFile } from './database/snapshot.js';
import { createPayPalIntegration } from './services/paypal/index.js';
import { buildDeps, createApp } from './app.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  // Sandbox-only guard: never boot against anything but SANDBOX.
  logger.fatal(e instanceof SandboxOnlyError ? e.message : `Invalid configuration: ${String(e)}`);
  process.exit(1);
}

const db = openDatabase(cfg.DATABASE_PATH);
if (cfg.IMPORT_SNAPSHOT) {
  const r = importSnapshotFile(db, path.join(REPO_ROOT, 'server/seed/hosted-snapshot.json'));
  logger.info(r, r.imported ? 'imported local history snapshot' : 'snapshot not imported');
}
const paypal = createPayPalIntegration(cfg);
const app = createApp(buildDeps(cfg, db, paypal));

const server = app.listen(cfg.PORT, () => {
  logger.info({ port: cfg.PORT, env: cfg.PAYPAL_ENVIRONMENT }, 'Refund Detective server listening');
});

// Start the MCP child in the background so the HTTP server is reachable immediately.
paypal.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await paypal.shutdown().catch(() => {});
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
