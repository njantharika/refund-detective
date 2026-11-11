import type { PayPalToolRegistry } from './paypal-tool-registry.js';
import { normalizeRefund } from './paypal-transaction.service.js';
import type { Money, NormalizedRefund, PayPalPath } from './paypal.types.js';

export class PayPalRefundService {
  constructor(private readonly registry: PayPalToolRegistry) {}

  async getRefund(refundId: string): Promise<{ refund: NormalizedRefund; path: PayPalPath }> {
    const { data, path } = await this.registry.read<Record<string, unknown>>('get_refund', { refund_id: refundId });
    return { refund: normalizeRefund(data), path };
  }

  /**
   * Approval-gated. Only the refund approval flow calls this: after a fresh FactSheet,
   * a passing council verdict, guardrails, an operation lock, and merchant confirmation.
   * MCP's create_refund has no per-call idempotency key, so the app-level key on the
   * `refunds` row is the guard (and is sent as PayPal-Request-Id on the REST fallback path).
   */
  async createRefund(
    input: { captureId: string; amount: Money; noteToPayer?: string; idempotencyKey: string },
    approval: { approved: true },
  ): Promise<{ refund: NormalizedRefund; path: PayPalPath }> {
    const args: Record<string, unknown> = {
      capture_id: input.captureId,
      amount: { currency_code: input.amount.currency, value: input.amount.value },
    };
    if (input.noteToPayer) args.note_to_payer = input.noteToPayer.slice(0, 255);
    const { data, path } = await this.registry.write<Record<string, unknown>>('create_refund', args, {
      approved: approval.approved,
      idempotencyKey: input.idempotencyKey,
    });
    return { refund: normalizeRefund(data), path };
  }
}
