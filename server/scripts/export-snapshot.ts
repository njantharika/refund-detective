/**
 * Read-only: writes the local app history to server/seed/hosted-snapshot.json so a hosted
 * deploy (IMPORT_SNAPSHOT=true) starts with the same investigations, councils and refunds.
 * Contains no credentials. PayPal state is re-fetched live by the hosted app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from '../src/config.js';
import { openDatabase } from '../src/database/db.js';
import { exportSnapshot } from '../src/database/snapshot.js';

const cfg = loadConfig();
const snap = exportSnapshot(openDatabase(cfg.DATABASE_PATH));
const out = path.join(REPO_ROOT, 'server/seed/hosted-snapshot.json');
fs.writeFileSync(out, JSON.stringify(snap, null, 1) + '\n');
console.log(`Wrote ${path.relative(REPO_ROOT, out)}:`, Object.fromEntries(Object.entries(snap.tables).map(([t, r]) => [t, r?.length ?? 0])));
