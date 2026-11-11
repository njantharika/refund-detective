/**
 * Live Sandbox smoke test: READ-ONLY. Spawns the app's own MCP client and exercises
 * list_transactions, get_order, get_refund, list_disputes and get_dispute.
 * Usage: npm run test:sandbox [-- <orderId>]
 */
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database/db.js';
import { createPayPalIntegration } from '../src/services/paypal/index.js';
import { PayPalError } from '../src/services/paypal/paypal.types.js';

const cfg = loadConfig();
const paypal = createPayPalIntegration(cfg);
const results: { check: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }[] = [];
const rec = (check: string, status: 'PASS' | 'FAIL' | 'SKIP', detail: string) => {
  results.push({ check, status, detail });
  console.log(`${status.padEnd(4)}  ${check.padEnd(22)} ${detail}`);
};
const msg = (e: unknown) => (e instanceof PayPalError ? `${e.code}${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}: ${e.message}` : String(e));

await paypal.start();
const st = paypal.mcp!.status();
rec('mcp_connect', st.state === 'ready' ? 'PASS' : 'FAIL', `${st.serverName ?? '?'} ${st.serverVersion ?? ''} · ${st.toolCount} tools · ${st.state}`);

let orderId: string | null = process.argv[2] ?? null;
let refundId: string | null = null;
let disputeId: string | null = null;

const search = await paypal.transactions.search({ from: new Date(Date.now() - 30 * 86_400_000), to: new Date() });
if (search.searchAvailable) rec('list_transactions', 'PASS', `${search.transactions.length} transactions in last 30 days`);
else rec('list_transactions', 'FAIL', search.searchError?.message ?? 'unavailable');

if (!orderId) {
  const db = openDatabase(cfg.DATABASE_PATH);
  orderId = (db.prepare('SELECT order_id FROM demo_orders ORDER BY created_at DESC LIMIT 1').pluck().get() as string | undefined) ?? null;
  db.close();
}
if (orderId) {
  try {
    const { order, path } = await paypal.transactions.getOrder(orderId);
    rec('get_order', 'PASS', `${order.id} ${order.status} · ${order.captures.length} capture(s) · via ${path}`);
    refundId = order.refunds[0]?.id ?? null;
  } catch (e) {
    rec('get_order', 'FAIL', msg(e));
  }
} else rec('get_order', 'SKIP', 'no order id: pass one as an argument or seed demo orders');

if (refundId) {
  try {
    const { refund } = await paypal.refunds.getRefund(refundId);
    rec('get_refund', 'PASS', `${refund.id} ${refund.status} ${refund.amount?.value ?? ''} ${refund.amount?.currency ?? ''}`);
  } catch (e) {
    rec('get_refund', 'FAIL', msg(e));
  }
} else rec('get_refund', 'SKIP', 'no refund on the order yet');

try {
  const { disputes } = await paypal.disputes.listDisputes({ pageSize: 10 });
  rec('list_disputes', 'PASS', `${disputes.length} dispute(s)`);
  disputeId = disputes[0]?.id ?? null;
} catch (e) {
  rec('list_disputes', 'FAIL', msg(e));
}
if (disputeId) {
  try {
    const { dispute } = await paypal.disputes.getDispute(disputeId);
    rec('get_dispute', 'PASS', `${dispute.id} ${dispute.status} ${dispute.reason}`);
  } catch (e) {
    rec('get_dispute', 'FAIL', msg(e));
  }
} else rec('get_dispute', 'SKIP', 'no disputes in this Sandbox account');

await paypal.shutdown();
const fails = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${results.filter((r) => r.status === 'PASS').length} pass · ${fails} fail · ${results.filter((r) => r.status === 'SKIP').length} skip`);
process.exit(fails ? 1 : 0);
