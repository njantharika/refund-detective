import fs from 'node:fs';
import { audit, type DB } from './db.js';

/**
 * A snapshot carries the app's own history (tracked Sandbox orders, investigations, evidence,
 * councils, refunds, audit) from a local run to a fresh hosted database. PayPal state is never
 * taken from it: FactSheets, refund status and eligibility are always re-fetched live.
 */
export const SNAPSHOT_TABLES = [
  'demo_orders',
  'investigations',
  'evidence',
  'investigation_messages',
  'deliberations',
  'refunds',
  'dispute_actions',
  'insight_summaries',
  'audit_log',
] as const;

export interface Snapshot {
  version: 1;
  exportedAt: string;
  environment: 'SANDBOX';
  tables: Partial<Record<(typeof SNAPSHOT_TABLES)[number], Record<string, unknown>[]>>;
}

const columnsOf = (db: DB, table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));

export function exportSnapshot(db: DB): Snapshot {
  const tables: Snapshot['tables'] = {};
  for (const t of SNAPSHOT_TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  return { version: 1, exportedAt: new Date().toISOString(), environment: 'SANDBOX', tables };
}

export type ImportResult = { imported: false; reason: string } | { imported: true; exportedAt: string; rows: number };

/** Imports only into a database with no history yet, so it can never overwrite or mix with real hosted records. */
export function importSnapshot(db: DB, snap: Snapshot): ImportResult {
  if (snap.version !== 1 || snap.environment !== 'SANDBOX') return { imported: false, reason: 'unsupported snapshot' };
  const existing = db.prepare('SELECT (SELECT COUNT(*) FROM investigations) + (SELECT COUNT(*) FROM demo_orders)').pluck().get() as number;
  if (existing > 0) return { imported: false, reason: 'database already has history' };
  let rows = 0;
  db.transaction(() => {
    for (const t of SNAPSHOT_TABLES) {
      const cols = columnsOf(db, t);
      for (const row of snap.tables[t] ?? []) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (!keys.length) continue;
        db.prepare(`INSERT OR IGNORE INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k] as never));
        rows++;
      }
    }
    audit(db, { actor: 'system', action: 'snapshot_imported', resourceType: 'database', request: { exportedAt: snap.exportedAt }, result: { rows } });
  })();
  return { imported: true, exportedAt: snap.exportedAt, rows };
}

export function importSnapshotFile(db: DB, file: string): ImportResult {
  if (!fs.existsSync(file)) return { imported: false, reason: `snapshot file not found` };
  return importSnapshot(db, JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot);
}

/** The most recent import, if any, so the UI can say the history came from a snapshot. */
export function lastSnapshotImport(db: DB): { exportedAt: string | null; rows: number | null; importedAt: string } | null {
  const r = db.prepare("SELECT request_summary, result_summary, created_at FROM audit_log WHERE action = 'snapshot_imported' ORDER BY id DESC LIMIT 1").get() as
    | { request_summary: string | null; result_summary: string | null; created_at: string }
    | undefined;
  if (!r) return null;
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  return { exportedAt: parse(r.request_summary).exportedAt ?? null, rows: parse(r.result_summary).rows ?? null, importedAt: r.created_at };
}
