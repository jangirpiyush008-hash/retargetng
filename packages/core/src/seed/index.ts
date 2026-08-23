import type pg from 'pg';
import type { EmbeddedPool } from '@aap/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@aap/db';
import { generateDataset, type GenerateResult } from './generator.js';
import { Rng } from './random.js';
import { bootstrapOrganization } from '../platform/org.js';
import { hashPassword } from '../platform/auth.js';
import { AudienceService } from '../audience/service.js';
import { STANDARD_AUDIENCES } from '../audience/templates.js';
import { MembershipEngine } from '../membership/engine.js';
import { DistributionEngine } from '../distribution/engine.js';
import { DestinationRegistry } from '../destinations/registry.js';
import { MeasurementService } from '../measurement/index.js';
import { DataQualityService } from '../quality/index.js';
import { PgJobQueue } from '../queue/pg-queue.js';
import { MemorySecretStore } from '../secrets/index.js';
import type { Principal } from '../rbac/index.js';

export interface SeedOptions {
  customers: number;
  events: number;
  seed?: number;
  orgName?: string;
  orgSlug?: string;
  adminEmail?: string;
  adminPassword?: string;
  /** evaluate + activate standard audiences (slower for 1M; still minutes) */
  activate?: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}
export interface SeedSummary { organizationId: string; data: GenerateResult; audiences: number; activated: number; users: Array<{ email: string; password: string; role: string }> }

export const DEMO_USERS = [
  { email: 'admin@demo.aap', name: 'Demo Admin', role: 'ADMIN', password: 'Admin12345!' },
  { email: 'marketer@demo.aap', name: 'Meera Marketer', role: 'MARKETING_MANAGER', password: 'Marketer12345!' },
  { email: 'campaigns@demo.aap', name: 'Karan Campaigns', role: 'CAMPAIGN_MANAGER', password: 'Campaign12345!' },
  { email: 'analyst@demo.aap', name: 'Anita Analyst', role: 'ANALYST', password: 'Analyst12345!' },
  { email: 'viewer@demo.aap', name: 'Vikram Viewer', role: 'VIEW_ONLY', password: 'Viewer12345!' },
] as const;

/** Full demo environment: organization, users, data, audiences, mock destinations, syncs, campaigns. */
export async function seedDemo(db: Kysely<DB>, pool: pg.Pool | EmbeddedPool, opts: SeedOptions): Promise<SeedSummary> {
  const log = opts.log ?? (() => {});
  const rng = new Rng((opts.seed ?? 42) + 7);
  const now = new Date();
  const slug = opts.orgSlug ?? 'demo';
  const existing = await db.selectFrom('organizations').select('id').where('slug', '=', slug).executeTakeFirst();
  if (existing) throw new Error(`organization "${slug}" already exists — run db:reset first or choose --org-slug`);
  const { organizationId: org } = await bootstrapOrganization(db, { name: opts.orgName ?? 'Demo Commerce Co.', slug, admin: { email: opts.adminEmail ?? DEMO_USERS[0].email, name: DEMO_USERS[0].name, password: opts.adminPassword ?? DEMO_USERS[0].password } });
  for (const u of DEMO_USERS.slice(1)) {
    const user = await db.insertInto('users').values({ email: u.email, name: u.name, password_hash: await hashPassword(u.password) }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst()
      ?? (await db.selectFrom('users').select('id').where('email', '=', u.email).executeTakeFirstOrThrow());
    await db.insertInto('organization_members').values({ organization_id: org, user_id: user.id, role: u.role }).onConflict((oc) => oc.doNothing()).execute();
  }
  await db.insertInto('data_sources').values({ organization_id: org, type: 'SYNTHETIC', name: 'Synthetic demo dataset', config: JSON.stringify({ customers: opts.customers, events: opts.events, seed: opts.seed ?? 42 }), status: 'ACTIVE', last_run_at: now }).execute();
  log('organization bootstrapped', { org });

  const data = await generateDataset(db, pool, { organizationId: org, customers: opts.customers, events: opts.events, seed: opts.seed, now, log });
  log('dataset generated', { ...data, durationMs: undefined, seconds: Math.round(data.durationMs / 1000) });
  await db.insertInto('ingestion_runs').values({ organization_id: org, status: 'SUCCESS', started_at: new Date(now.getTime() - data.durationMs), finished_at: new Date(), rows_read: data.customers, rows_upserted: data.customers, events_emitted: data.events, checkpoint: JSON.stringify({ seed: opts.seed ?? 42 }) }).execute();

  // ---- destinations (mock mode by default; META/GOOGLE_ADS resolve to mocks)
  const registry = new DestinationRegistry();
  const secrets = new MemorySecretStore();
  const queue = new PgJobQueue(db);
  const principal: Principal = { type: 'SYSTEM', id: null, label: 'seed', organizationId: org, role: 'SUPER_ADMIN' };
  const accounts: Record<string, string> = {};
  for (const [type, name, acctId, acctName] of [['META', 'Meta Ads — Demo Business', 'act_100000001', 'Demo Commerce — Main Ad Account'], ['GOOGLE_ADS', 'Google Ads — Demo', '1234567890', 'Demo Commerce — Google Ads']] as const) {
    const d = await db.insertInto('destinations').values({ organization_id: org, type, name, status: 'CONNECTED', config: JSON.stringify(type === 'META' ? { api_version: 'v25.0', customer_file_source: 'USER_PROVIDED_ONLY', business_id: '100000000000001' } : { api_version: 'v21', login_customer_id: '9876543210', membership_life_span_days: 540 }),
      connection_status: JSON.stringify({ ok: true, message: `Connected (${registry.isMock(type) ? 'mock mode — no data leaves this system' : 'live'})`, checked_at: now.toISOString() }), last_tested_at: now }).returning('id').executeTakeFirstOrThrow();
    const a = await db.insertInto('destination_accounts').values({ destination_id: d.id, organization_id: org, external_account_id: acctId, name: acctName, currency: 'INR', timezone: 'Asia/Kolkata', is_default: true }).returning('id').executeTakeFirstOrThrow();
    accounts[type] = a.id;
  }

  // ---- audiences: standard recency windows + product templates
  const audiences = new AudienceService(db, queue);
  const created = new Map<string, string>();
  for (const s of STANDARD_AUDIENCES) {
    const { id } = await audiences.create(principal, { name: s.name, slug: s.slug, templateKey: s.templateKey, templateParams: s.params, priority: s.priority, evaluationSchedule: s.schedule, status: 'ACTIVE', description: `Standard ${s.templateKey.toLowerCase().replace(/_/g, ' ')} audience (${JSON.stringify(s.params)})`, holdoutPercent: s.slug === 'LAPSED_180D' ? 10 : 0 });
    created.set(s.slug, id);
  }
  const shoes = await db.selectFrom('products').select('id').where('organization_id', '=', org).where('external_product_id', '=', 'sku_0006').executeTakeFirstOrThrow();
  const socks = await db.selectFrom('products').select('id').where('organization_id', '=', org).where('external_product_id', '=', 'sku_0007').executeTakeFirstOrThrow();
  const skincare = await db.selectFrom('categories').select('id').where('organization_id', '=', org).where('external_category_id', '=', 'skincare').executeTakeFirstOrThrow();
  const extra = [
    { name: 'Running Shoes Buyers', slug: 'RUNNING_SHOES_BUYERS', templateKey: 'PRODUCT_BUYER', templateParams: { productIds: [shoes.id] }, priority: 25, evaluationSchedule: 'EVERY_6_HOURS' as const },
    { name: 'Shoes → Socks Cross-sell', slug: 'SHOES_CROSS_SELL_SOCKS', templateKey: 'CROSS_SELL', templateParams: { boughtProductIds: [shoes.id], notBoughtProductIds: [socks.id] }, priority: 26, evaluationSchedule: 'EVERY_6_HOURS' as const },
    { name: 'Skincare Buyers — 90 days', slug: 'SKINCARE_BUYERS_90D', templateKey: 'CATEGORY_BUYER', templateParams: { categoryIds: [skincare.id], withinDays: 90 }, priority: 27, evaluationSchedule: 'EVERY_6_HOURS' as const },
    { name: 'Winback — high value, 90 days', slug: 'WINBACK_HV_90D', templateKey: 'WINBACK', templateParams: { days: 90, minLtv: 5000 }, priority: 38, evaluationSchedule: 'DAILY' as const },
    { name: 'High AOV Customers', slug: 'HIGH_AOV_CUSTOMERS', templateKey: 'HIGH_AOV', templateParams: { minAov: 3000 }, priority: 36, evaluationSchedule: 'DAILY' as const },
    { name: 'Dormant — 60 days', slug: 'DORMANT_60D', templateKey: 'DORMANT', templateParams: { days: 60 }, priority: 60, evaluationSchedule: 'DAILY' as const },
    { name: 'New Customers — 30 days', slug: 'NEW_CUSTOMERS_30D', templateKey: 'NEW_CUSTOMER', templateParams: { days: 30 }, priority: 30, evaluationSchedule: 'HOURLY' as const },
  ];
  for (const e of extra) { const { id } = await audiences.create(principal, { ...e, status: 'ACTIVE', description: `${e.name} (template ${e.templateKey})` }); created.set(e.slug, id); }
  // exclusions: cart abandoners & lapsed exclude recent purchasers; cross-sell excludes recent
  const recent1 = created.get('RECENT_PURCHASERS_1D')!, recent30 = created.get('RECENT_PURCHASERS_30D')!;
  for (const s of ['CART_ABANDONERS_1_3D', 'CART_ABANDONERS_4_7D', 'CART_ABANDONERS_8_14D']) await audiences.update(principal, created.get(s)!, { excludeAudienceIds: [recent1] });
  for (const s of ['LAPSED_30D', 'LAPSED_60D', 'LAPSED_90D', 'LAPSED_180D', 'LAPSED_365D', 'WINBACK_HV_90D', 'DORMANT_60D']) await audiences.update(principal, created.get(s)!, { excludeAudienceIds: [recent30] });
  await audiences.update(principal, created.get('SHOES_CROSS_SELL_SOCKS')!, { excludeAudienceIds: [recent1] });
  await db.deleteFrom('job_queue').execute(); // we evaluate inline below
  log('audiences created', { count: created.size });
  return finishDemo(db, pool, { organizationId: org, data, accounts, log, activate: opts.activate, seed: opts.seed });
}

/** Idempotent post-load phase: evaluate audiences, synthesize history, activate to mock destinations, campaigns, holdout, quality, stats. Safe to re-run (`--resume`). */
export async function finishDemo(db: Kysely<DB>, pool: pg.Pool | EmbeddedPool, opts: { organizationId: string; data: GenerateResult; accounts: Record<string, string>; log?: SeedOptions['log']; activate?: boolean; seed?: number }): Promise<SeedSummary> {
  const log = opts.log ?? (() => {});
  const rng = new Rng((opts.seed ?? 42) + 11);
  const now = new Date();
  const org = opts.organizationId;
  const accounts = opts.accounts;
  const registry = new DestinationRegistry();
  const secrets = new MemorySecretStore();
  const queue = new PgJobQueue(db);
  const principal: Principal = { type: 'SYSTEM', id: null, label: 'seed', organizationId: org, role: 'SUPER_ADMIN' };
  const engine = new MembershipEngine(db);
  void pool;

  // ---- evaluate all not-yet-evaluated audiences (FULL), then synthesize 30 days of history for the charts
  const created = new Map<string, string>((await db.selectFrom('audiences').select(['slug', 'id']).where('organization_id', '=', org).where('status', '<>', 'ARCHIVED').orderBy('priority').execute()).map((a) => [a.slug, a.id]));
  let i = 0;
  for (const [slugName, id] of created) {
    i++;
    const existing = await db.selectFrom('audiences').select(['last_evaluated_at', 'member_count']).where('id', '=', id).executeTakeFirstOrThrow();
    let memberCount = Number(existing.member_count);
    if (!existing.last_evaluated_at) { const r = await engine.evaluate(id, { mode: 'FULL', now }); memberCount = r.memberCount; log(`evaluated ${slugName}`, { members: r.memberCount, ms: r.durationMs, progress: `${i}/${created.size}` }); }
    else log(`already evaluated ${slugName}`, { members: memberCount, progress: `${i}/${created.size}` });
    if (await db.selectFrom('audience_stats_daily').select('day').where('audience_id', '=', id).where('day', '<', now).limit(1).executeTakeFirst()) continue;
    const rows = [] as Array<{ audience_id: string; day: string; member_count: number; entered: number; exited: number }>;
    let m = memberCount;
    for (let d = 30; d >= 1; d--) {
      const entered = Math.round(m * (0.01 + rng.next() * 0.04)), exited = Math.round(m * (0.01 + rng.next() * 0.04));
      m = Math.max(0, Math.round(m * (0.97 + rng.next() * 0.06)));
      rows.push({ audience_id: id, day: new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10), member_count: m, entered, exited });
    }
    if (rows.length) await db.insertInto('audience_stats_daily').values(rows).onConflict((oc) => oc.doNothing()).execute();
  }
  await engine.recomputePrimary(org, null, new Date());

  // ---- activate a representative set to the mock destinations and run initial syncs
  let activated = 0;
  if (opts.activate !== false) {
    const dist = new DistributionEngine({ db, queue, secrets, registry });
    const plan: Array<[string, string[]]> = [['CART_ABANDONERS_1_3D', ['META', 'GOOGLE_ADS']], ['CART_ABANDONERS_4_7D', ['META']], ['RECENT_PURCHASERS_7D', ['META']], ['LAPSED_180D', ['META', 'GOOGLE_ADS']], ['VIP_CUSTOMERS', ['GOOGLE_ADS']], ['HIGH_VALUE_CUSTOMERS', ['META']], ['SHOES_CROSS_SELL_SOCKS', ['META']], ['WINBACK_HV_90D', ['GOOGLE_ADS']]];
    for (const [slugName, types] of plan) {
      const id = created.get(slugName)!;
      const res = await dist.activate(principal, id, { destinationAccountIds: types.map((t) => accounts[t]!) });
      if (res.dryRun) continue;
      for (const adId of res.audienceDestinationIds!) {
        const already = await db.selectFrom('audience_destinations').select('last_synced_at').where('id', '=', adId).executeTakeFirstOrThrow();
        if (already.last_synced_at) { log(`already synced ${slugName}`); continue; }
        const r = await dist.runSync({ organizationId: org, audienceDestinationId: adId, trigger: 'INITIAL', now });
        activated++; log(`synced ${slugName}`, { status: r.status, eligible: r.eligibleCount, added: r.added, batches: r.batchesTotal });
      }
    }
    await db.deleteFrom('job_queue').execute();
  }

  // ---- campaigns + 60 days of metrics (synthetic platform-reported numbers)
  const measurement = new MeasurementService(db);
  const existingCampaigns = Number((await db.selectFrom('campaigns').select((eb) => eb.fn.countAll<number>().as('n')).where('organization_id', '=', org).executeTakeFirstOrThrow()).n);
  const campaignPlan: Array<[string, string, string]> = existingCampaigns > 0 ? [] : [['Cart Recovery — Meta', 'CART_ABANDONERS_1_3D', 'META'], ['Cart Recovery — Google', 'CART_ABANDONERS_1_3D', 'GOOGLE_ADS'], ['Winback 180D — Meta', 'LAPSED_180D', 'META'], ['Winback 180D — YouTube', 'LAPSED_180D', 'GOOGLE_ADS'], ['VIP Early Access — Google', 'VIP_CUSTOMERS', 'GOOGLE_ADS'], ['Shoes → Socks — Meta', 'SHOES_CROSS_SELL_SOCKS', 'META']];
  for (const [name, audSlug, type] of campaignPlan) {
    const c = await db.insertInto('campaigns').values({ organization_id: org, destination_account_id: accounts[type]!, external_campaign_id: `${type.toLowerCase()}_${rng.int(100000, 999999)}`, name, objective: audSlug.startsWith('CART') ? 'Sales' : audSlug.startsWith('VIP') ? 'Engagement' : 'Conversions', status: 'ACTIVE', start_date: new Date(now.getTime() - 60 * 86400_000).toISOString().slice(0, 10) }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('campaign_audiences').values({ campaign_id: c.id, audience_id: created.get(audSlug)! }).execute();
    const base = audSlug.startsWith('CART') ? 1.0 : audSlug.startsWith('VIP') ? 0.4 : 0.7;
    const rows = [] as Array<Record<string, unknown>>;
    for (let d = 60; d >= 1; d--) {
      const impressions = Math.round(base * (40_000 + rng.next() * 30_000));
      const clicks = Math.round(impressions * (0.009 + rng.next() * 0.012));
      const spend = Math.round(clicks * (6 + rng.next() * 8));
      const conversions = Math.round(clicks * (audSlug.startsWith('CART') ? 0.05 + rng.next() * 0.04 : 0.02 + rng.next() * 0.02));
      const value = Math.round(conversions * (1400 + rng.next() * 1800));
      rows.push({ campaign_id: c.id, day: new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10), impressions, clicks, spend, conversions, conversion_value: value, reach: Math.round(impressions * 0.55), frequency: 1.4 + rng.next() * 1.2 });
    }
    await db.insertInto('campaign_metrics_daily').values(rows as never).execute();
  }
  await measurement.rollupHoldoutOutcomes(created.get('LAPSED_180D')!, new Date(now.getTime() - 30 * 86400_000), now);
  await new DataQualityService(db).compute(org);
  await measurement.refreshCustomerStats(org);
  await sql`ANALYZE audience_members; ANALYZE audience_destination_members; ANALYZE sync_jobs;`.execute(db);
  log('seed complete');
  return { organizationId: org, data: opts.data, audiences: created.size, activated, users: DEMO_USERS.map((u) => ({ email: u.email, password: u.password, role: u.role })) };
}
