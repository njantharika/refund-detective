import { useQuery } from '@tanstack/react-query';
import { Activity, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, type WebhookEvent } from '../lib/api';
import { dateTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Card, EmptyState, ErrorState, Notice, Pill, Skeleton } from '../components/ui';

export function EventMonitorPage() {
  const ev = useQuery({ queryKey: ['events'], queryFn: () => api<{ configured: boolean; items: WebhookEvent[] }>('/api/events'), refetchInterval: 10_000 });
  return (
    <>
      <PageHeader title="Event Monitor" subtitle="PayPal webhooks, signature-verified with PayPal before they can be used as evidence." />
      {ev.error && <ErrorState error={ev.error} onRetry={() => ev.refetch()} />}
      {ev.isLoading && <Skeleton className="h-40" />}
      {ev.data && !ev.data.configured && (
        <Card title="Not configured">
          <EmptyState icon={Activity} title="Webhooks are not configured">
            <div className="space-y-2 text-left">
              <p>No events are simulated. To receive real Sandbox events:</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Expose the server: <code className="mono">cloudflared tunnel --url http://localhost:3001</code> (or <code className="mono">ngrok http 3001</code>).
                </li>
                <li>
                  In the PayPal Developer Dashboard → your Sandbox app → Webhooks, add <code className="mono">https://&lt;tunnel&gt;/api/webhooks/paypal</code> for PAYMENT.CAPTURE.* and CUSTOMER.DISPUTE.* events.
                </li>
                <li>
                  Put the webhook ID in <code className="mono">.env</code> as <code className="mono">PAYPAL_WEBHOOK_ID</code> and restart.
                </li>
              </ol>
            </div>
          </EmptyState>
        </Card>
      )}
      {ev.data?.configured && (
        <>
          <div className="mb-6">
            <Notice tone="info" icon={ShieldCheck} title="Only signature-verified events are evidence">
              Each event is verified with PayPal's verify-webhook-signature API and deduplicated by event ID. Unverified events are listed here but never used by the investigator.
            </Notice>
          </div>
          <Card padded={false}>
            {ev.data.items.length === 0 ? (
              <EmptyState icon={Activity} title="No events received yet">Trigger a Sandbox capture or refund to see events arrive.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                      <th className="px-4 py-3 font-medium">Time</th>
                      <th className="px-4 py-3 font-medium">Event</th>
                      <th className="px-4 py-3 font-medium">Linked IDs</th>
                      <th className="px-4 py-3 font-medium">Signature</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.data.items.map((e) => (
                      <tr key={e.id} className="border-t border-white/[0.04]">
                        <td className="whitespace-nowrap px-4 py-3 text-slate-300">{dateTime(e.eventTime)}</td>
                        <td className="px-4 py-3">
                          <div className="mono text-[13px] text-slate-200">{e.eventType}</div>
                          <div className="text-xs text-slate-500">{e.summary}</div>
                        </td>
                        <td className="mono px-4 py-3 text-[11px] text-slate-400">{e.relatedIds.join(' · ')}</td>
                        <td className="px-4 py-3">
                          {e.verified ? (
                            <Pill tone="success" icon={ShieldCheck}>
                              verified
                            </Pill>
                          ) : (
                            <Pill tone="danger" icon={ShieldAlert}>
                              unverified
                            </Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
