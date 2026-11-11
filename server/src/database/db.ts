import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Opens the database (":memory:" for tests) and applies any SQL migrations not yet recorded. */
export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    })();
  }
  return db;
}

export function audit(
  db: DB,
  entry: { actor: string; action: string; resourceType?: string; resourceId?: string | null; request?: unknown; result?: unknown },
) {
  const s = (v: unknown) => (v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
  db.prepare(
    'INSERT INTO audit_log (actor, action, resource_type, resource_id, request_summary, result_summary) VALUES (?,?,?,?,?,?)',
  ).run(entry.actor, entry.action, entry.resourceType ?? null, entry.resourceId ?? null, s(entry.request), s(entry.result));
}
