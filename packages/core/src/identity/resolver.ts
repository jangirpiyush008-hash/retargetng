import type { Kysely, Transaction } from 'kysely';
import type { DB } from '@aap/db';

export type MatchedBy = 'EXTERNAL_ID' | 'EMAIL' | 'PHONE' | 'HISTORY';
export interface ResolveInput { externalCustomerId?: string | null; emailHash?: Buffer | null; phoneHash?: Buffer | null }
export interface ResolveResult { customerId: number | null; matchedBy: MatchedBy | null; ambiguous: boolean }

/**
 * Canonical identity resolution (first-party only). Priority:
 *   external_customer_id → current email hash → current phone hash → historical identifiers.
 * Never merges records automatically; ambiguity (one hash on several customers) is reported so
 * the data-quality layer can surface it, and the lowest id wins deterministically.
 */
export class IdentityResolver {
  constructor(private db: Kysely<DB> | Transaction<DB>) {}

  async resolve(organizationId: string, input: ResolveInput): Promise<ResolveResult> {
    const db = this.db;
    if (input.externalCustomerId) {
      const r = await db.selectFrom('customers').select('id').where('organization_id', '=', organizationId)
        .where('external_customer_id', '=', input.externalCustomerId).executeTakeFirst();
      if (r) return { customerId: r.id, matchedBy: 'EXTERNAL_ID', ambiguous: false };
    }
    if (input.emailHash) {
      const rows = await db.selectFrom('customers').select('id').where('organization_id', '=', organizationId)
        .where('email_hash', '=', input.emailHash).where('deleted', '=', false).orderBy('id').limit(2).execute();
      if (rows.length) return { customerId: rows[0]!.id, matchedBy: 'EMAIL', ambiguous: rows.length > 1 };
    }
    if (input.phoneHash) {
      const rows = await db.selectFrom('customers').select('id').where('organization_id', '=', organizationId)
        .where('phone_hash', '=', input.phoneHash).where('deleted', '=', false).orderBy('id').limit(2).execute();
      if (rows.length) return { customerId: rows[0]!.id, matchedBy: 'PHONE', ambiguous: rows.length > 1 };
    }
    for (const [kind, hash] of [['EMAIL', input.emailHash], ['PHONE', input.phoneHash]] as const) {
      if (!hash) continue;
      const r = await db.selectFrom('identity_history').select('customer_id').where('organization_id', '=', organizationId)
        .where('kind', '=', kind).where('previous_hash', '=', hash).orderBy('occurred_at', 'desc').executeTakeFirst();
      if (r) return { customerId: r.customer_id, matchedBy: 'HISTORY', ambiguous: false };
    }
    return { customerId: null, matchedBy: null, ambiguous: false };
  }
}
