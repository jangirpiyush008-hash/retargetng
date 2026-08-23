import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { hashPassword } from './auth.js';
import { DEFAULT_POLICY } from '../consent/policy.js';
import type { Role } from '../rbac/index.js';

export const DEFAULT_RETENTION: Record<string, number> = {
  raw_events: 730, cart_events: 730, membership_history: 730, sync_batches: 90, audit_logs: 2555, sessions: 30, deleted_customers: 30, eval_runs: 180,
};

/** Creates an organization with default compliance policies and retention, optionally the first admin. */
export async function bootstrapOrganization(db: Kysely<DB>, input: { name: string; slug: string; admin?: { email: string; name: string; password: string; role?: Role }; settings?: Record<string, unknown> }) {
  return db.transaction().execute(async (trx) => {
    const org = await trx.insertInto('organizations').values({ name: input.name, slug: input.slug, settings: JSON.stringify({ currency: 'INR', timezone: 'Asia/Kolkata', lifecycle: { vipLifetimeValue: 25000, repeatOrders: 2 }, ...(input.settings ?? {}) }) }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('compliance_policies').values([
      { organization_id: org.id, name: 'Default (strict): explicit consent, advertising + data-sharing flags', destination_type: null, is_default: true, rules: JSON.stringify(DEFAULT_POLICY) },
      { organization_id: org.id, name: 'Meta — default', destination_type: 'META', is_default: true, rules: JSON.stringify(DEFAULT_POLICY) },
      { organization_id: org.id, name: 'Google Ads — default', destination_type: 'GOOGLE_ADS', is_default: true, rules: JSON.stringify(DEFAULT_POLICY) },
    ]).execute();
    await trx.insertInto('retention_policies').values(Object.entries(DEFAULT_RETENTION).map(([data_class, retention_days]) => ({ organization_id: org.id, data_class, retention_days }))).execute();
    let userId: string | undefined;
    if (input.admin) {
      const existing = await trx.selectFrom('users').select('id').where('email', '=', input.admin.email.toLowerCase()).executeTakeFirst();
      userId = existing?.id ?? (await trx.insertInto('users').values({ email: input.admin.email.toLowerCase(), name: input.admin.name, password_hash: await hashPassword(input.admin.password) }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('organization_members').values({ organization_id: org.id, user_id: userId, role: input.admin.role ?? 'ADMIN' }).onConflict((oc) => oc.doNothing()).execute();
    }
    return { organizationId: org.id, userId };
  });
}
