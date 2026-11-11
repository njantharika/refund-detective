export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Refund Detective server');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

/* ------------------------------- API types ------------------------------- */

export interface Money {
  value: string;
  currency: string;
}

export interface Transaction {
  transactionId: string | null;
  orderId: string | null;
  captureId: string | null;
  status: string | null;
  eventCode: string | null;
  amount: Money | null;
  fee: Money | null;
  initiatedAt: string | null;
  updatedAt: string | null;
  payerCountry: string | null;
  note: string | null;
  source: 'transaction_search' | 'demo_order';
}

export interface Sources {
  transactionSearch: { available: boolean; error: { code: string; httpStatus: number | null; message: string } | null; count: number; path: string | null };
  demoOrders: { tracked: number; fetched: number; errors: { orderId: string; message: string }[] };
}

export interface TransactionList {
  items: Transaction[];
  page: number;
  pageSize: number;
  total: number;
  facets: { statuses: string[]; currencies: string[] };
  sources: Sources;
  fetchedAt: string;
}

export interface Refund {
  id: string;
  status: string | null;
  amount: Money | null;
  createdAt: string | null;
  updatedAt: string | null;
  noteToPayer: string | null;
}

export interface Capture {
  id: string;
  status: string | null;
  amount: Money | null;
  finalCapture: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  refunds: Refund[];
}

export interface Order {
  id: string;
  status: string | null;
  intent: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  amount: Money | null;
  description: string | null;
  captures: Capture[];
  refunds: Refund[];
  approveUrl: string | null;
}

export interface Dispute {
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

export interface TransactionDetails {
  id: string;
  order: Order | null;
  transaction: Transaction | null;
  captures: Capture[];
  refunds: Refund[];
  disputes: Dispute[];
  events: { id: string; event_type: string; resource_id: string; event_time: string; signature_verified: number }[];
  investigations: { id: string; status: string; summary: string | null; confidence: number | null; created_at: string }[];
  errors: { section: string; message: string }[];
}

export interface DashboardSummary {
  range: { from: string; to: string };
  dataMode: 'live' | 'empty';
  kpis: {
    total: number;
    nonPaymentActivity: number;
    successful: number;
    failed: number;
    pending: number;
    capturedVolume: Record<string, number>;
    refunds: { count: number; amount: Record<string, number> };
    activity: { date: string; count: number; volume: number }[];
    refundTrend: { date: string; count: number }[];
    openInvestigations: number;
    openDisputes: number | null;
  };
  investigationPipeline: Record<'open' | 'awaiting_approval' | 'resolved' | 'closed', number>;
  recentActivity: { actor: string; action: string; resource_type: string | null; resource_id: string | null; created_at: string }[];
  sources: Sources & { disputesError: string | null };
  fetchedAt: string;
}

export interface IntegrationStatus {
  appVersion: string;
  paypal: {
    environment: string;
    apiBase: string;
    auth: { mode: 'client_credentials' | 'static_token' | 'none'; hasToken: boolean; expiresAt: string | null; warning: string | null; lastError: string | null };
    mcp: { state: string; serverName: string | null; serverVersion: string | null; toolCount: number; restarts: number; lastError: string | null; command: string } | null;
    tools: { name: string; allowed: boolean }[];
    missingAllowedTools: string[];
    lastCall: { tool: string; path: string; ok: boolean; durationMs: number; at: string; errorCode: string | null } | null;
    pathUsage: { mcp: number; rest_fallback: number };
    restFallback: { available: boolean; active: boolean };
  };
  ai: { provider: string; configured: boolean; message: string | null; models: Record<'investigator' | 'advocate' | 'challenger' | 'judge', string>; councilRebuttal: boolean };
  database: { path: string; sizeBytes: number | null };
  webhooks: { configured: boolean; received: number };
}

export interface ConnectionTest {
  checks: { tool: string; ok: boolean; path: string | null; durationMs: number; message: string | null; hint: string | null }[];
  at: string;
}

/* ----------------------------- investigations ----------------------------- */

export type Stage = 'collecting' | 'analyzing' | 'ready' | 'failed' | 'ai_unavailable';

export interface FactSheet {
  targetCaptureId: string | null;
  orderId: string | null;
  orderStatus: string | null;
  captureStatus: string | null;
  captureCount: number;
  currency: string | null;
  capturedAmount: string | null;
  completedRefundTotal: string | null;
  pendingRefundTotal: string | null;
  remainingRefundable: string | null;
  refunds: { id: string; status: string | null; amount: string | null; currency: string | null }[];
  openDisputes: string[];
  hasOpenDispute: boolean;
  appPendingRefund: boolean;
  appRefundsUnknown: boolean;
  lockHeld: boolean;
  currencyMismatch: boolean;
  conflictingStatuses: string[];
  missingEvidence: string[];
  refundBlockers: string[];
  refundEligible: boolean;
  computedAt: string;
}

export interface Evidence {
  id: string;
  type: string;
  source: 'paypal_mcp' | 'paypal_rest' | 'webhook_verified' | 'app_internal' | 'merchant_input';
  description: string;
  observedAt: string | null;
  normalized: Record<string, unknown>;
  verified: boolean;
  provenance: { tool: string | null; path: string | null; fetchedAt: string } | null;
}

export interface Finding {
  title: string;
  explanation: string;
  evidenceIds: string[];
  kind: 'observed' | 'inferred';
  severity: 'low' | 'medium' | 'high';
}

export interface Report {
  caseSummary: string;
  customerComplaint: string;
  transactionStatus: string;
  findings: Finding[];
  likelyRootCause: { description: string; confidence: number; supportingEvidenceIds: string[]; limitations: string[] };
  alternativeExplanations: { description: string; evidenceIds: string[] }[];
  missingInformation: string[];
  proposedDecision: { type: string; amount: string | null; currency: string | null; reason: string };
}

export interface Investigation {
  id: string;
  transactionId: string | null;
  orderId: string | null;
  captureId: string | null;
  complaint: string | null;
  status: string;
  stage: Stage;
  stageDetail: string | null;
  error: string | null;
  running: boolean;
  createdAt: string;
  updatedAt: string;
  factSheet: FactSheet | null;
  evidence: Evidence[];
  report: Report | null;
  citationAudit: { removedFindings: { title: string; invalidIds: string[]; reason: string }[]; droppedIds: string[] } | null;
  toolCalls: { tool: string; id: string; reason: string; status: string; detail: string; addedEvidenceIds: string[] }[];
  model: string | null;
  generatedAt: string | null;
  messages: { id: number; role: 'merchant' | 'investigator'; content: string; evidenceIds: string[]; kind: string | null; model: string | null; created_at: string }[];
}

export interface InvestigationListItem {
  id: string;
  transactionId: string | null;
  orderId: string | null;
  captureId: string | null;
  status: string;
  stage: Stage;
  summary: string | null;
  confidence: number | null;
  createdAt: string;
}
