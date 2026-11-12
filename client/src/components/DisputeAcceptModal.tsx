import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api, type Deliberation, type Investigation } from '../lib/api';
import { Button, ErrorState, Field, Modal, Notice } from './ui';
import { VerdictBadge } from './CouncilPanel';

export const acceptLabel = (id: string) => `Accept claim ${id}`;

/** Final human gate for accepting a buyer's dispute claim (irreversible: PayPal refunds the buyer). */
export function DisputeAcceptModal({ inv, deliberation, onClose }: { inv: Investigation; deliberation: Deliberation | null; onClose: () => void }) {
  const qc = useQueryClient();
  const disputeId = deliberation?.executableDispute?.disputeId ?? null;
  const [authorized, setAuthorized] = useState(false);
  useEffect(() => setAuthorized(false), [deliberation?.id]);
  const accept = useMutation({
    mutationFn: () => api<{ status: string; paypal_response_summary: string }>(`/api/investigations/${inv.id}/dispute/accept`, { method: 'POST', body: JSON.stringify({ deliberationId: deliberation!.id, disputeId, confirmationText: acceptLabel(disputeId!) }) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['council', inv.id] }),
  });
  if (!deliberation || !disputeId) return null;
  return (
    <Modal open onClose={onClose} title="Review & accept dispute claim" labelledBy="dispute-modal-title">
      {accept.data ? (
        <div className="space-y-4">
          <Notice tone={accept.data.status === 'completed' ? 'info' : 'danger'} icon={accept.data.status === 'completed' ? CheckCircle2 : AlertTriangle} title={`Accept claim: ${accept.data.status}`}>
            {accept.data.paypal_response_summary}
          </Notice>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Notice tone="warning" title="This cannot be undone">
            Accepting the claim tells PayPal to refund the buyer the disputed amount and closes the dispute in the buyer's favour (Sandbox).
          </Notice>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Dispute" mono>{disputeId}</Field>
            <Field label="Capture" mono>{inv.captureId ?? 'Not available'}</Field>
          </dl>
          <div className="flex items-center gap-2 text-sm text-slate-300">
            Council verdict: <VerdictBadge v={deliberation.finalOutcome} />
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/10 p-3 text-sm text-slate-200">
            <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5 h-4 w-4 accent-violet" />I authorize accepting this Sandbox dispute claim
          </label>
          {accept.error && <ErrorState title="Not executed" error={accept.error} />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={!authorized || accept.isPending} onClick={() => accept.mutate()}>
              {accept.isPending ? 'Accepting…' : acceptLabel(disputeId)}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
