import type { PayPalToolRegistry } from './paypal-tool-registry.js';
import { toMoney } from './paypal-transaction.service.js';
import type { NormalizedDispute, PayPalPath } from './paypal.types.js';

type AnyObj = Record<string, any>;

export function normalizeDispute(d: AnyObj): NormalizedDispute {
  const txIds: string[] = (d?.disputed_transactions ?? [])
    .map((t: AnyObj) => t?.seller_transaction_id ?? t?.buyer_transaction_id)
    .filter((x: unknown): x is string => typeof x === 'string');
  return {
    id: String(d?.dispute_id ?? ''),
    status: d?.status ?? null,
    reason: d?.reason ?? null,
    stage: d?.dispute_life_cycle_stage ?? null,
    amount: toMoney(d?.dispute_amount),
    createdAt: d?.create_time ?? null,
    updatedAt: d?.update_time ?? null,
    disputedTransactionIds: txIds,
    outcome: d?.dispute_outcome?.outcome_code ?? null,
  };
}

export const OPEN_DISPUTE_STATUSES = new Set(['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW']);

export class PayPalDisputeService {
  constructor(private readonly registry: PayPalToolRegistry) {}

  async listDisputes(opts: { disputedTransactionId?: string; pageSize?: number } = {}): Promise<{ disputes: NormalizedDispute[]; path: PayPalPath }> {
    const args: Record<string, unknown> = { page_size: opts.pageSize ?? 50 };
    if (opts.disputedTransactionId) args.disputed_transaction_id = opts.disputedTransactionId;
    const { data, path } = await this.registry.read<AnyObj>('list_disputes', args);
    return { disputes: (data?.items ?? []).map(normalizeDispute), path };
  }

  async getDispute(disputeId: string): Promise<{ dispute: NormalizedDispute; raw: unknown; path: PayPalPath }> {
    const { data, path } = await this.registry.read<AnyObj>('get_dispute', { dispute_id: disputeId });
    return { dispute: normalizeDispute(data), raw: data, path };
  }

  /** Approval-gated; only reachable via a council-approved, merchant-confirmed flow. */
  async acceptClaim(disputeId: string, note: string, approval: { approved: true }) {
    return this.registry.write('accept_dispute_claim', { dispute_id: disputeId, note: note.slice(0, 2000) }, { approved: approval.approved });
  }
}
