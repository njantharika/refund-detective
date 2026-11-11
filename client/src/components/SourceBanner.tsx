import { Database } from 'lucide-react';
import type { Sources } from '../lib/api';
import { Notice } from './ui';

/** Tells the merchant exactly which PayPal data sources are live, and why one isn't. Never hides a 403. */
export function SourceBanner({ sources }: { sources: Sources | undefined }) {
  if (!sources) return null;
  const ts = sources.transactionSearch;
  const out = [];
  if (!ts.available && ts.error) {
    out.push(
      <Notice key="ts" title={ts.error.httpStatus === 403 ? 'PayPal Transaction Search is not enabled for this Sandbox app' : 'PayPal Transaction Search is unavailable'}>
        {ts.error.message}
        {sources.demoOrders.tracked > 0 ? (
          <> Showing {sources.demoOrders.fetched} order(s) this app created, fetched live with <code className="mono">get_order</code>.</>
        ) : (
          <> No app-created orders are tracked yet, so there is no PayPal data to show.</>
        )}
      </Notice>,
    );
  }
  if (sources.demoOrders.errors.length) {
    out.push(
      <Notice key="do" tone="danger" icon={Database} title={`${sources.demoOrders.errors.length} tracked order(s) could not be fetched from PayPal`}>
        {sources.demoOrders.errors.slice(0, 3).map((e) => (
          <div key={e.orderId}>
            <span className="mono">{e.orderId}</span>: {e.message}
          </div>
        ))}
      </Notice>,
    );
  }
  return out.length ? <div className="mb-6 space-y-3">{out}</div> : null;
}
