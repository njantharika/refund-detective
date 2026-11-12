/** Which integration path served a PayPal call. Surfaced in Settings; never faked. */
export type PayPalPath = 'mcp' | 'rest_fallback';

export interface Money {
  value: string; // decimal string, as PayPal returns it
  currency: string;
}

export interface NormalizedTransaction {
  transactionId: string | null;
  orderId: string | null;
  captureId: string | null;
  status: string | null; // e.g. COMPLETED, PENDING, DENIED, REVERSED, or raw T-code status
  eventCode: string | null;
  amount: Money | null;
  fee: Money | null;
  initiatedAt: string | null;
  updatedAt: string | null;
  payerCountry: string | null;
  note: string | null;
  /** For refunds/reversals in Transaction Search: the capture they refer to. */
  referenceId?: string | null;
  source: 'transaction_search' | 'demo_order';
}

export interface NormalizedRefund {
  id: string;
  /** Capture this refund belongs to, from PayPal's HATEOAS "up" link (null when not provided). */
  captureId?: string | null;
  status: string | null;
  amount: Money | null;
  createdAt: string | null;
  updatedAt: string | null;
  noteToPayer: string | null;
}

export interface NormalizedCapture {
  id: string;
  status: string | null;
  amount: Money | null;
  finalCapture: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  refunds: NormalizedRefund[]; // from purchase_units[].payments.refunds linked via links/up, when present
}

export interface NormalizedOrder {
  id: string;
  status: string | null;
  intent: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  amount: Money | null;
  description: string | null;
  captures: NormalizedCapture[];
  refunds: NormalizedRefund[]; // all refunds on the order, as listed under payments.refunds
  approveUrl: string | null;
}

export interface NormalizedDispute {
  id: string;
  status: string | null;
  reason: string | null;
  stage: string | null;
  amount: Money | null;
  createdAt: string | null;
  updatedAt: string | null;
  disputedTransactionIds: string[];
  outcome: string | null;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly code: string,
    public readonly tool?: string,
  ) {
    super(message);
  }
}
