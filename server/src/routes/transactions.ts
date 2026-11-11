import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { AppError } from '../lib/errors.js';
import { PayPalError, type NormalizedOrder, type NormalizedTransaction } from '../services/paypal/paypal.types.js';

const PAGE_SIZE = 25;
const DAY = 86_400_000;

export const RangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  refresh: z.enum(['true', 'false']).optional(),
});

const ListQuery = RangeQuery.extend({
  status: z.string().max(40).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  q: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).default('date_desc'),
});

export function resolveRange(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
  if (from > to) throw new AppError(400, 'INVALID_RANGE', '`from` must be before `to`');
  if (to.getTime() - from.getTime() > 3 * 366 * DAY) throw new AppError(400, 'RANGE_TOO_LARGE', 'Maximum range is 3 years');
  return { from, to };
}

const IdParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid transaction or order id') });

export function transactionsRouter({ explorer, paypal, db }: AppDeps) {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = ListQuery.parse(req.query);
    const snap = await explorer.snapshot(resolveRange(q), q.refresh === 'true');
    let rows = snap.transactions;
    if (q.status) rows = rows.filter((t) => (t.status ?? '').toUpperCase() === q.status!.toUpperCase());
    if (q.currency) rows = rows.filter((t) => t.amount?.currency === q.currency);
    if (q.q) {
      const needle = q.q.toUpperCase();
      rows = rows.filter((t) => [t.transactionId, t.orderId, t.captureId].some((v) => v?.toUpperCase().includes(needle)));
    }
    rows = sortRows(rows, q.sort);
    const total = rows.length;
    res.json({
      items: rows.slice((q.page - 1) * PAGE_SIZE, q.page * PAGE_SIZE),
      page: q.page,
      pageSize: PAGE_SIZE,
      total,
      facets: {
        statuses: [...new Set(snap.transactions.map((t) => t.status).filter(Boolean))].sort(),
        currencies: [...new Set(snap.transactions.map((t) => t.amount?.currency).filter(Boolean))].sort(),
      },
      sources: snap.sources,
      fetchedAt: snap.fetchedAt,
    });
  });

  /**
   * Details for an order id or capture/transaction id: live order, captures, refunds, disputes,
   * and investigations. Each section reports its own error instead of failing the whole view.
   */
  r.get('/:id/details', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const errors: { section: string; message: string }[] = [];
    let order: NormalizedOrder | null = null;
    let transaction: NormalizedTransaction | null = null;

    // 1) Is it an order id? Try get_order directly.
    try {
      order = (await paypal.transactions.getOrder(id)).order;
    } catch (e) {
      if (!(e instanceof PayPalError) || (e.httpStatus !== 404 && e.code !== 'INVALID_TOOL_ARGS')) {
        errors.push({ section: 'order', message: e instanceof Error ? e.message : String(e) });
      }
    }
    // 2) Otherwise treat it as a capture id: look among orders this app knows about.
    if (!order) {
      const known = db.prepare('SELECT order_id FROM demo_orders').pluck().all() as string[];
      const fromInvestigation = db.prepare('SELECT order_id FROM investigations WHERE capture_id = ? AND order_id IS NOT NULL LIMIT 1').pluck().get(id) as string | undefined;
      for (const oid of [fromInvestigation, ...known].filter(Boolean) as string[]) {
        try {
          const o = (await paypal.transactions.getOrder(oid)).order;
          if (o.captures.some((c) => c.id === id)) {
            order = o;
            break;
          }
        } catch {
          /* reported via the explorer's source errors */
        }
      }
    }
    // 3) Transaction Search by id (may be unavailable: 403 without the permission).
    const captureIds = order ? order.captures.map((c) => c.id) : [id];
    try {
      transaction = (await paypal.transactions.getTransactionById(captureIds[0] ?? id)).transaction;
    } catch (e) {
      errors.push({ section: 'transaction_search', message: e instanceof Error ? e.message : String(e) });
    }
    if (!order && !transaction) {
      const forbidden = errors.find((x) => /permission|403/i.test(x.message));
      throw new AppError(404, 'NOT_FOUND', forbidden ? `No order found for ${id}, and Transaction Search is unavailable (${forbidden.message})` : `No PayPal order or transaction found for ${id}`);
    }

    // 4) Disputes for each capture.
    const disputes = [];
    for (const cid of captureIds) {
      try {
        disputes.push(...(await paypal.disputes.listDisputes({ disputedTransactionId: cid })).disputes);
      } catch (e) {
        errors.push({ section: 'disputes', message: e instanceof Error ? e.message : String(e) });
        break;
      }
    }

    const ids = [id, order?.id, ...captureIds].filter(Boolean);
    const placeholders = ids.map(() => '?').join(',');
    const investigations = db
      .prepare(`SELECT id, status, summary, confidence, created_at FROM investigations WHERE order_id IN (${placeholders}) OR capture_id IN (${placeholders}) OR transaction_id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...ids, ...ids, ...ids);
    const events = db
      .prepare(`SELECT id, event_type, resource_id, event_time, signature_verified FROM webhook_events WHERE resource_id IN (${placeholders}) ORDER BY event_time DESC LIMIT 50`)
      .all(...ids);

    res.json({
      id,
      order,
      transaction,
      captures: order?.captures ?? [],
      refunds: order?.refunds ?? [],
      disputes,
      events,
      investigations,
      errors,
    });
  });

  return r;
}

function amountOf(t: NormalizedTransaction) {
  return t.amount ? Number(t.amount.value) : 0;
}

function sortRows(rows: NormalizedTransaction[], sort: string) {
  const copy = [...rows];
  switch (sort) {
    case 'date_asc':
      return copy.sort((a, b) => (a.initiatedAt ?? '').localeCompare(b.initiatedAt ?? ''));
    case 'amount_desc':
      return copy.sort((a, b) => amountOf(b) - amountOf(a));
    case 'amount_asc':
      return copy.sort((a, b) => amountOf(a) - amountOf(b));
    default:
      return copy.sort((a, b) => (b.initiatedAt ?? '').localeCompare(a.initiatedAt ?? ''));
  }
}
