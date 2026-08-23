import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { emailHash, phoneHash } from '../identity/normalize.js';
import { AuditLogger } from '../audit/index.js';
import { assertCan, type Principal } from '../rbac/index.js';
import { ValidationError } from '../util/index.js';
import { maskHash } from '../observability/logger.js';

export type SuppressionReason = 'UNSUBSCRIBE' | 'PRIVACY_REQUEST' | 'CUSTOMER_DELETION' | 'ADVERTISING_OPT_OUT' | 'LEGAL_RESTRICTION' | 'INTERNAL_BLACKLIST' | 'FRAUD' | 'CUSTOMER_COMPLAINT' | 'OTHER';

/** Global suppression: first-class, overrides every audience rule, applied by hash tombstone even for unknown customers. */
export class SuppressionService {
  private audit: AuditLogger;
  constructor(private db: Kysely<DB>) { this.audit = new AuditLogger(db); }

  async add(principal: Principal, input: { customerId?: number; email?: string; phone?: string; reason: SuppressionReason; note?: string; expiresAt?: Date | null; source?: string }) {
    assertCan(principal, 'suppression:write');
    const org = principal.organizationId;
    const eh = input.email ? emailHash(input.email) : null;
    const ph = input.phone ? phoneHash(input.phone) : null;
    if (!input.customerId && !eh && !ph) throw new ValidationError('customerId, email or phone is required');
    // resolve customer ids by hash (may be several) — all are suppressed
    let ids: number[] = [];
    if (input.customerId) ids = [input.customerId];
    else {
      const rows = await this.db.selectFrom('customers').select('id').where('organization_id', '=', org).where((eb) => eb.or([...(eh ? [eb('email_hash', '=', eh)] : []), ...(ph ? [eb('phone_hash', '=', ph)] : [])])).execute();
      ids = rows.map((r) => r.id);
    }
    const created: number[] = [];
    await this.db.transaction().execute(async (trx) => {
      const base = { organization_id: org, reason: input.reason, note: input.note ?? null, created_by: principal.id, expires_at: input.expiresAt ?? null, source: input.source ?? 'manual' };
      if (!ids.length) {
        // tombstone by hash: future imports of this identifier are born suppressed
        const r = await trx.insertInto('suppression_records').values({ ...base, customer_id: null, identifier_kind: eh ? 'EMAIL' : 'PHONE', identifier_hash: (eh ?? ph)! }).returning('id').executeTakeFirstOrThrow();
        created.push(r.id);
      }
      for (const id of ids) {
        const c = await trx.selectFrom('customers').select(['email_hash', 'phone_hash']).where('id', '=', id).where('organization_id', '=', org).executeTakeFirstOrThrow();
        const r = await trx.insertInto('suppression_records').values({ ...base, customer_id: id, identifier_kind: eh ? 'EMAIL' : ph ? 'PHONE' : c.email_hash ? 'EMAIL' : c.phone_hash ? 'PHONE' : null, identifier_hash: eh ?? ph ?? c.email_hash ?? c.phone_hash }).returning('id').executeTakeFirstOrThrow();
        created.push(r.id);
        await trx.updateTable('customers').set({ suppressed: true, suppressed_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute();
      }
      await this.audit.log({ organizationId: org, actor: principal, action: 'SUPPRESSION_ADDED', entityType: 'suppression', entityId: created.join(','), metadata: { reason: input.reason, customers: ids.length, tombstone: !ids.length, identifier: maskHash(eh ?? ph) } }, trx);
    });
    return { suppressionIds: created, customersSuppressed: ids.length };
  }

  async revoke(principal: Principal, suppressionId: number) {
    assertCan(principal, 'suppression:write');
    const org = principal.organizationId;
    await this.db.transaction().execute(async (trx) => {
      const s = await trx.updateTable('suppression_records').set({ revoked_at: new Date() }).where('id', '=', suppressionId).where('organization_id', '=', org).where('revoked_at', 'is', null).returning(['customer_id', 'reason']).executeTakeFirst();
      if (!s) throw new ValidationError('Suppression not found or already revoked');
      if (s.customer_id) {
        const still = await trx.selectFrom('suppression_records').select('id').where('customer_id', '=', s.customer_id).where('revoked_at', 'is', null).limit(1).executeTakeFirst();
        const deleted = await trx.selectFrom('customers').select('deleted').where('id', '=', s.customer_id).executeTakeFirstOrThrow();
        if (!still && !deleted.deleted) await trx.updateTable('customers').set({ suppressed: false, suppressed_at: null, updated_at: new Date() }).where('id', '=', s.customer_id).execute();
      }
      await this.audit.log({ organizationId: org, actor: principal, action: 'SUPPRESSION_REVOKED', entityType: 'suppression', entityId: suppressionId, before: { reason: s.reason } }, trx);
    });
  }

  async list(org: string, opts: { cursor?: string; limit?: number; reason?: string } = {}) {
    const limit = Math.min(200, opts.limit ?? 50);
    let q = this.db.selectFrom('suppression_records').select(['id', 'customer_id', 'identifier_kind', 'identifier_hash', 'reason', 'scope', 'source', 'note', 'created_at', 'expires_at', 'revoked_at']).where('organization_id', '=', org).orderBy('id', 'desc').limit(limit + 1);
    if (opts.cursor) q = q.where('id', '<', Number(opts.cursor));
    if (opts.reason) q = q.where('reason', '=', opts.reason);
    const rows = await q.execute();
    const page = rows.slice(0, limit).map((r) => ({ ...r, identifier_hash: maskHash(r.identifier_hash) }));
    return { data: page, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
  }
  async stats(org: string) {
    const rows = await this.db.selectFrom('suppression_records').select(['reason']).select((eb) => eb.fn.countAll<number>().as('n')).where('organization_id', '=', org).where('revoked_at', 'is', null).groupBy('reason').execute();
    const total = await this.db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).where('organization_id', '=', org).where('suppressed', '=', true).executeTakeFirstOrThrow();
    return { suppressedCustomers: Number(total.n), byReason: Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)])) };
  }
}
