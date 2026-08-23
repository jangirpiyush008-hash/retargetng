import type pg from 'pg';
import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { finishDemo, type SeedOptions, type SeedSummary } from './index.js';

/** Resume the post-load phase for an existing demo organization (data already loaded). */
export async function resumeDemo(db: Kysely<DB>, pool: pg.Pool, opts: { orgSlug: string; log?: SeedOptions['log']; activate?: boolean; seed?: number }): Promise<SeedSummary> {
  const org = await db.selectFrom('organizations').select('id').where('slug', '=', opts.orgSlug).executeTakeFirst();
  if (!org) throw new Error(`organization "${opts.orgSlug}" not found`);
  const accounts: Record<string, string> = {};
  for (const a of await db.selectFrom('destination_accounts as da').innerJoin('destinations as d', 'd.id', 'da.destination_id').select(['da.id', 'd.type']).where('da.organization_id', '=', org.id).execute()) accounts[a.type] = a.id;
  const counts = (await db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).where('organization_id', '=', org.id).executeTakeFirstOrThrow()).n;
  return finishDemo(db, pool, { organizationId: org.id, data: { customers: Number(counts), orders: 0, orderItems: 0, events: 0, cartEvents: 0, products: 0, durationMs: 0 }, accounts, log: opts.log, activate: opts.activate, seed: opts.seed });
}
