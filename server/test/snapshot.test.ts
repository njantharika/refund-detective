import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/database/db.js';
import { exportSnapshot, importSnapshot, lastSnapshotImport } from '../src/database/snapshot.js';

const seeded = () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO demo_orders (order_id, label, amount, currency, status) VALUES ('ORDER1', 'x', '10.00', 'USD', 'COMPLETED')").run();
  db.prepare("INSERT INTO investigations (id, order_id, capture_id, complaint, status, stage) VALUES ('inv_1', 'ORDER1', 'CAP1', 'c', 'open', 'ready')").run();
  return db;
};

describe('history snapshot', () => {
  it('round-trips app history into an empty database and records the import', () => {
    const snap = exportSnapshot(seeded());
    const fresh = openDatabase(':memory:');
    const r = importSnapshot(fresh, snap);
    expect(r).toMatchObject({ imported: true });
    expect(fresh.prepare('SELECT order_id FROM demo_orders').pluck().all()).toEqual(['ORDER1']);
    expect(fresh.prepare('SELECT id FROM investigations').pluck().all()).toEqual(['inv_1']);
    expect(lastSnapshotImport(fresh)).toMatchObject({ exportedAt: snap.exportedAt });
  });

  it('never imports into a database that already has history (so restarts do not duplicate)', () => {
    const snap = exportSnapshot(seeded());
    const db = seeded();
    expect(importSnapshot(db, snap)).toEqual({ imported: false, reason: 'database already has history' });
    expect(db.prepare('SELECT COUNT(*) FROM investigations').pluck().get()).toBe(1);
  });

  it('rejects a non-Sandbox snapshot', () => {
    const snap = { ...exportSnapshot(seeded()), environment: 'LIVE' } as never;
    expect(importSnapshot(openDatabase(':memory:'), snap)).toMatchObject({ imported: false });
  });
});
