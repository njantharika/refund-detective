import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { api, type RefundRecord } from '../lib/api';
import { dateTime } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Card, EmptyState, ErrorState, Skeleton, StatusBadge } from '../components/ui';

export function RefundsPage() {
  const list = useQuery({ queryKey: ['refunds-all'], queryFn: () => api<{ items: RefundRecord[] }>('/api/refunds'), refetchInterval: 10_000 });
  return (
    <>
      <PageHeader title="Refunds" subtitle="Every refund executed through Refund Detective: council-approved, merchant-confirmed, verified with PayPal get_refund." />
      {list.error && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
      <Card padded={false}>
        {list.isLoading && <Skeleton className="m-5 h-16" />}
        {list.data && list.data.items.length === 0 && (
          <EmptyState icon={RotateCcw} title="No refunds yet">
            Refunds start from an investigation, pass the Decision Council, and need your explicit approval.
          </EmptyState>
        )}
        {list.data && list.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">Approved</th>
                  <th className="px-4 py-3 font-medium">PayPal refund</th>
                  <th className="px-4 py-3 font-medium">Capture</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Status (PayPal)</th>
                  <th className="px-4 py-3 font-medium">Case</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.04]">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-300">{dateTime(r.approvedAt)}</td>
                    <td className="mono px-4 py-3 text-[13px] text-slate-200">{r.paypalRefundId ?? '—'}</td>
                    <td className="mono px-4 py-3 text-[13px] text-slate-400">{r.captureId}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-100">
                      {r.amount} {r.currency}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status === 'unknown' ? 'RECONCILING' : r.status.toUpperCase()} tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'} />
                      <div className="mt-1 max-w-xs truncate text-[11px] text-slate-500" title={r.paypalResponseSummary ?? ''}>
                        {r.paypalResponseSummary}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link className="mono text-[12px] text-blue-300 hover:underline" to={`/investigations/${r.investigationId}`}>
                        {r.investigationId}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
