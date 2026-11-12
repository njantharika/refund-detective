/**
 * Seeds Sandbox demo orders. THIS IS A PAYPAL WRITE OPERATION: run only with explicit go-ahead.
 *
 *   npm run seed:sandbox -- create [count]   create_order ×count (default 3), print approval URLs
 *   npm run seed:sandbox -- capture          pay_order every approved, uncaptured demo order
 *   npm run seed:sandbox -- status           read-only: show demo orders and their live status
 *
 * Refunds are never issued here: those go through the in-app council + approval flow.
 */
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database/db.js';
import { createPayPalIntegration } from '../src/services/paypal/index.js';
import { normalizeOrder } from '../src/services/paypal/paypal-transaction.service.js';

const SCENARIOS = [
  { label: 'untouched', item: 'Detective Field Notebook', value: '42.00' },
  { label: 'partial-refund', item: 'Magnifier Pro Lens', value: '64.00' },
  { label: 'full-refund', item: 'Trench Coat (Sandbox)', value: '25.00' },
  { label: 'wrong-size', item: 'Fedora Hat, size M', value: '38.50' },
  { label: 'late-delivery', item: 'Evidence Kit Deluxe', value: '129.99' },
  { label: 'duplicate-charge-claim', item: 'Fingerprint Powder Set', value: '17.25' },
  { label: 'not-received', item: 'Noir Novel Box Set', value: '54.00' },
  { label: 'damaged', item: 'Vintage Desk Lamp', value: '86.40' },
  { label: 'happy-customer', item: 'Gift Card (Sandbox)', value: '10.00' },
];

const [cmd = 'status', countArg] = process.argv.slice(2);
const cfg = loadConfig();
const db = openDatabase(cfg.DATABASE_PATH);
const paypal = createPayPalIntegration(cfg);
await paypal.start();

try {
  if (cmd === 'create') {
    const count = Math.min(Number(countArg ?? SCENARIOS.length) || SCENARIOS.length, 10);
    // Continue through the catalogue after the orders that already exist.
    const offset = db.prepare('SELECT COUNT(*) FROM demo_orders').pluck().get() as number;
    for (let i = 0; i < count; i++) {
      const s = SCENARIOS[(offset + i) % SCENARIOS.length];
      const { data } = await paypal.registry.write<Record<string, unknown>>(
        'create_order',
        { currencyCode: 'USD', items: [{ name: s.item, quantity: 1, itemCost: Number(s.value), taxPercent: 0, itemTotal: Number(s.value) }] },
        { approved: true },
      );
      const order = normalizeOrder(data);
      db.prepare('INSERT OR REPLACE INTO demo_orders (order_id, label, amount, currency, approve_url, status) VALUES (?,?,?,?,?,?)').run(
        order.id, s.label, s.value, 'USD', order.approveUrl, order.status,
      );
      console.log(`created ${order.id} [${s.label}] USD ${s.value}\n  approve as Sandbox buyer: ${order.approveUrl}`);
    }
    console.log('\nApprove each URL with a Sandbox *personal* account, then run: npm run seed:sandbox -- capture');
  } else if (cmd === 'capture') {
    const rows = db.prepare('SELECT order_id, label FROM demo_orders').all() as { order_id: string; label: string }[];
    for (const r of rows) {
      const { order } = await paypal.transactions.getOrder(r.order_id);
      if (order.status !== 'APPROVED') {
        console.log(`skip ${r.order_id} [${r.label}]: status ${order.status}`);
        continue;
      }
      try {
        await paypal.registry.write('pay_order', { id: r.order_id }, { approved: true });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const declined = /declined|INSTRUMENT_DECLINED/i.test(m);
        console.log(`FAILED ${r.order_id} [${r.label}]: ${m.slice(0, 200)}`);
        if (declined) console.log(`  buyer must re-approve with another funding source: https://www.sandbox.paypal.com/checkoutnow?token=${r.order_id}`);
        continue;
      }
      const after = (await paypal.transactions.getOrder(r.order_id)).order;
      db.prepare('UPDATE demo_orders SET status = ? WHERE order_id = ?').run(after.status, r.order_id);
      console.log(`captured ${r.order_id} [${r.label}] → ${after.status}, capture ${after.captures[0]?.id ?? '?'}`);
    }
  } else {
    const rows = db.prepare('SELECT order_id, label FROM demo_orders').all() as { order_id: string; label: string }[];
    if (!rows.length) console.log('no demo orders yet');
    for (const r of rows) {
      const { order } = await paypal.transactions.getOrder(r.order_id);
      console.log(`${r.order_id} [${r.label}] ${order.status} · captures: ${order.captures.map((c) => `${c.id}:${c.status}`).join(', ') || 'none'}`);
    }
  }
} finally {
  await paypal.shutdown();
  db.close();
}
