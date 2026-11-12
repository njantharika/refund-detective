import { randomUUID } from 'node:crypto';
import type { DB } from '../../database/db.js';
import { audit } from '../../database/db.js';
import { logger, scrubSecrets } from '../../lib/logger.js';
import type { PayPalAuth } from './paypal-auth.js';
import { redact } from '../investigation/evidence.js';

export const WEBHOOK_HEADERS = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'] as const;

type AnyObj = Record<string, any>;

/** Every PayPal ID an event refers to: the resource, its related IDs, and IDs in its HATEOAS links. */
export function relatedIds(event: AnyObj): string[] {
  const r: AnyObj = event?.resource ?? {};
  const ids = new Set<string>();
  const add = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) && ids.add(v);
  add(r.id);
  const rel = r.supplementary_data?.related_ids ?? {};
  for (const v of Object.values(rel)) add(v);
  for (const l of r.links ?? []) {
    const m = typeof l?.href === 'string' ? l.href.match(/\/(?:orders|captures|refunds|authorizations|disputes)\/([A-Za-z0-9_-]+)/) : null;
    if (m) add(m[1]);
  }
  add(r.dispute_id);
  for (const t of r.disputed_transactions ?? []) add(t?.seller_transaction_id);
  return [...ids];
}

export function summarizeEvent(event: AnyObj): string {
  const r = event?.resource ?? {};
  const amt = r.amount?.value ? ` ${r.amount.value} ${r.amount.currency_code ?? ''}` : '';
  return `${event?.event_type ?? 'UNKNOWN'} ${r.id ?? ''}${amt}${r.status ? ` (${r.status})` : ''}`.trim();
}

/**
 * Verifies PayPal webhook signatures via POST /v1/notifications/verify-webhook-signature, deduplicates on the
 * PayPal event ID and persists the event. Unverified events are stored for visibility but never used as evidence.
 */
export class PayPalWebhookService {
  constructor(
    private readonly deps: { db: DB; auth: PayPalAuth; webhookId: string | undefined; apiBase: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured() {
    return Boolean(this.deps.webhookId);
  }

  async verify(headers: Record<string, string | undefined>, event: unknown): Promise<{ verified: boolean; reason: string }> {
    if (!this.deps.webhookId) return { verified: false, reason: 'PAYPAL_WEBHOOK_ID not configured' };
    const missing = WEBHOOK_HEADERS.filter((h) => !headers[h]);
    if (missing.length) return { verified: false, reason: `Missing headers: ${missing.join(', ')}` };
    try {
      const token = await this.deps.auth.getToken();
      const res = await this.fetchImpl(`${this.deps.apiBase}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: this.deps.webhookId,
          webhook_event: event,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { verified: false, reason: `verify-webhook-signature HTTP ${res.status}` };
      const body = (await res.json()) as { verification_status?: string };
      return body.verification_status === 'SUCCESS' ? { verified: true, reason: 'SUCCESS' } : { verified: false, reason: `verification_status ${body.verification_status ?? 'missing'}` };
    } catch (e) {
      return { verified: false, reason: scrubSecrets(e instanceof Error ? e.message : String(e)) };
    }
  }

  async receive(headers: Record<string, string | undefined>, event: AnyObj): Promise<{ status: 'stored' | 'duplicate'; verified: boolean; reason: string; id: string | null }> {
    const eventId = typeof event?.id === 'string' ? event.id : null;
    if (!eventId) return { status: 'stored', verified: false, reason: 'Event has no id; ignored', id: null };
    const existing = this.deps.db.prepare('SELECT id, signature_verified FROM webhook_events WHERE paypal_event_id = ?').get(eventId) as { id: string; signature_verified: number } | undefined;
    if (existing) return { status: 'duplicate', verified: !!existing.signature_verified, reason: 'Already received', id: existing.id };

    const v = await this.verify(headers, event);
    const ids = relatedIds(event);
    const id = `wh_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.deps.db
      .prepare('INSERT OR IGNORE INTO webhook_events (id, paypal_event_id, event_type, resource_id, event_time, signature_verified, payload_json, processing_status, related_ids, summary) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, eventId, String(event.event_type ?? 'UNKNOWN'), ids[0] ?? null, event.create_time ?? new Date().toISOString(), v.verified ? 1 : 0, JSON.stringify(redact(event)), v.verified ? 'verified' : `rejected: ${v.reason}`.slice(0, 200), `,${ids.join(',')},`, summarizeEvent(event).slice(0, 300));
    audit(this.deps.db, { actor: 'system', action: v.verified ? 'webhook_verified' : 'webhook_rejected', resourceType: 'webhook_event', resourceId: eventId, result: { type: event.event_type, reason: v.reason } });
    logger.info({ eventType: event.event_type, verified: v.verified }, 'paypal webhook received');
    return { status: 'stored', verified: v.verified, reason: v.reason, id };
  }

  list(limit = 200) {
    return (this.deps.db.prepare('SELECT id, paypal_event_id, event_type, resource_id, event_time, signature_verified, processing_status, related_ids, summary, created_at FROM webhook_events ORDER BY event_time DESC LIMIT ?').all(limit) as AnyObj[]).map((r) => ({
      id: r.id,
      paypalEventId: r.paypal_event_id,
      eventType: r.event_type,
      resourceId: r.resource_id,
      eventTime: r.event_time,
      verified: !!r.signature_verified,
      processingStatus: r.processing_status,
      relatedIds: String(r.related_ids ?? '').split(',').filter(Boolean),
      summary: r.summary,
      receivedAt: r.created_at,
    }));
  }
}
