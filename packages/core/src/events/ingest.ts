import { sql, type Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { InboundEventBatchSchema, type InboundEvent } from './schema.js';
import { hashIdentifiers } from '../identity/normalize.js';
import { piiCipher } from '../crypto/pii.js';
import { sha256, stableStringify } from '../crypto/hash.js';
import { metrics } from '../observability/metrics.js';
import type { JobQueue } from '../queue/types.js';

/** The sanitized customer reference stored in customer_events.payload — never raw PII. */
export interface StoredCustomerRef {
  external_customer_id?: string;
  email_hash?: string;          // hex of EMAIL_SHA256
  email_hash_google?: string;   // hex of EMAIL_SHA256_GOOGLE
  email_enc?: string;           // base64 AES-GCM ciphertext
  email_valid?: boolean;
  phone_hash?: string;          // hex of PHONE_E164_SHA256
  phone_hash_digits?: string;   // hex of PHONE_DIGITS_SHA256
  phone_enc?: string;
  phone_valid?: boolean;
  country?: string | null;
}

export interface IngestResult { accepted: number; duplicates: number; rejected: Array<{ index: number; event_id?: string; errors: string[] }>; }

export class EventIngestor {
  constructor(private db: Kysely<DB>, private queue: JobQueue) {}

  /** Validates, sanitizes PII, stores idempotently and enqueues processing. */
  async ingest(organizationId: string, rawEvents: unknown, opts: { source?: string } = {}): Promise<IngestResult> {
    const arr = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [] };
    const valid: InboundEvent[] = [];
    const parsedBatch = InboundEventBatchSchema.safeParse(arr);
    if (!parsedBatch.success) {
      // validate individually to report per-item errors
      for (let i = 0; i < arr.length; i++) {
        const r = InboundEventBatchSchema.element.safeParse(arr[i]);
        if (r.success) valid.push(r.data);
        else result.rejected.push({ index: i, event_id: (arr[i] as { event_id?: string })?.event_id, errors: r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
      }
      if (!arr.length || arr.length > 1000) result.rejected.push({ index: -1, errors: ['batch must contain 1..1000 events'] });
    } else valid.push(...parsedBatch.data);
    if (!valid.length) return result;

    const cipher = piiCipher();
    const rows = valid.map((e) => {
      const h = hashIdentifiers({ email: e.customer.email, phone: e.customer.phone, country: e.customer.country });
      const ref: StoredCustomerRef = { external_customer_id: e.customer.external_customer_id, country: e.customer.country ?? undefined };
      if (h.email) {
        ref.email_hash = h.email.hashes.EMAIL_SHA256.toString('hex');
        ref.email_hash_google = h.email.hashes.EMAIL_SHA256_GOOGLE.toString('hex');
        ref.email_enc = cipher.encrypt(h.email.normalized).toString('base64');
        ref.email_valid = h.email.valid;
      }
      if (h.phone) {
        ref.phone_hash = h.phone.hashes.PHONE_E164_SHA256.toString('hex');
        ref.phone_hash_digits = h.phone.hashes.PHONE_DIGITS_SHA256.toString('hex');
        ref.phone_enc = cipher.encrypt(h.phone.e164).toString('base64');
        ref.phone_valid = h.phone.valid;
      }
      const payload = { customer: ref, data: e.payload };
      return {
        organization_id: organizationId,
        event_id: e.event_id,
        event_type: e.event_type,
        external_customer_id: e.customer.external_customer_id ?? null,
        source: e.source ?? opts.source ?? null,
        payload: JSON.stringify(payload),
        payload_hash: sha256(stableStringify({ t: e.event_type, c: { ...ref, email_enc: undefined, phone_enc: undefined }, d: e.payload })),
        occurred_at: e.occurred_at,
      };
    });

    const inserted = await this.db.insertInto('customer_events').values(rows)
      .onConflict((oc) => oc.columns(['organization_id', 'event_id', 'occurred_at']).doNothing())
      .returning(['id', 'occurred_at']).execute();
    result.accepted = inserted.length;
    result.duplicates = rows.length - inserted.length;
    metrics.eventsIngested.inc({}, result.accepted);
    metrics.eventsDuplicate.inc({}, result.duplicates);
    if (inserted.length) {
      await this.queue.enqueue({
        queue: 'events.process', name: 'process-events',
        payload: { organizationId, events: inserted.map((r) => ({ id: r.id, occurredAt: r.occurred_at.toISOString() })) },
        priority: 50,
      });
    }
    return result;
  }

  /** Crash-recovery sweep: re-enqueue PENDING events older than `olderThanSeconds`. */
  async sweepPending(organizationId: string | null, olderThanSeconds = 300, limit = 5000): Promise<number> {
    let q = this.db.selectFrom('customer_events').select(['id', 'occurred_at', 'organization_id'])
      .where('processing_status', '=', 'PENDING')
      .where('received_at', '<', sql<Date>`now() - make_interval(secs => ${olderThanSeconds})`)
      .orderBy('received_at').limit(limit);
    if (organizationId) q = q.where('organization_id', '=', organizationId);
    const rows = await q.execute();
    const byOrg = new Map<string, Array<{ id: number; occurredAt: string }>>();
    for (const r of rows) { const a = byOrg.get(r.organization_id) ?? []; a.push({ id: r.id, occurredAt: r.occurred_at.toISOString() }); byOrg.set(r.organization_id, a); }
    for (const [org, events] of byOrg) {
      for (let i = 0; i < events.length; i += 500) {
        await this.queue.enqueue({ queue: 'events.process', name: 'process-events', payload: { organizationId: org, events: events.slice(i, i + 500) }, priority: 60 });
      }
    }
    return rows.length;
  }
}
