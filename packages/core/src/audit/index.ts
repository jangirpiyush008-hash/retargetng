import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@aap/db';
import type { Principal } from '../rbac/index.js';

export interface AuditEntry {
  organizationId: string;
  actor: Principal | { type: 'SYSTEM'; id?: null; label?: string };
  action: string;           // e.g. AUDIENCE_CREATED, AUDIENCE_ACTIVATED, DESTINATION_CONNECTED
  entityType?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Writes who/what/when/where/before/after. Callers must never pass raw PII in before/after. */
export class AuditLogger {
  constructor(private db: Kysely<DB>) {}
  async log(entry: AuditEntry, trx?: Transaction<DB>): Promise<void> {
    await (trx ?? this.db).insertInto('audit_logs').values({
      organization_id: entry.organizationId,
      actor_type: entry.actor.type,
      actor_id: entry.actor.id ?? null,
      actor_label: entry.actor.label ?? 'system',
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId != null ? String(entry.entityId) : null,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      metadata: JSON.stringify(entry.metadata ?? {}),
      ip: entry.ip ?? null,
      user_agent: entry.userAgent ?? null,
    }).execute();
  }
}
export const SYSTEM_ACTOR = { type: 'SYSTEM' as const, id: null, label: 'system' };
