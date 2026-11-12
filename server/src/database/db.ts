import Database from 'better-sqlite3';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  const cols = db.prepare('PRAGMA table_info(schema_migrations)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  const applied = new Map((db.prepare('SELECT name, checksum FROM schema_migrations').all() as { name: string; checksum: string | null }[]).map((r) => [r.name, r.checksum]));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      const recorded = applied.get(file);
      // Applied migrations are immutable: an edited file would silently never run (seen in development).
      if (recorded && recorded !== checksum) throw new Error(`Migration ${file} was modified after it was applied. Add a new migration instead.`);
      if (!recorded) db.prepare('UPDATE schema_migrations SET checksum = ? WHERE name = ?').run(checksum, file);
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)').run(file, new Date().toISOString(), checksum);
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
