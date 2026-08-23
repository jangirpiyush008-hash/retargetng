import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '@aap/db/test-utils';
import { DistributionEngine } from './engine.js';
import { MembershipEngine } from '../membership/engine.js';
import { AudienceService } from '../audience/service.js';
import { PgJobQueue } from '../queue/pg-queue.js';
import { DestinationRegistry } from '../destinations/registry.js';
import { MockDestinationAdapter, MockMetaAdapter, MockGoogleAdapter } from '../destinations/adapters/mock.js';
import { MemorySecretStore } from '../secrets/index.js';
import { createOrg, insertCustomer } from '../testing/fixtures.js';
import { sha256 } from '../crypto/hash.js';
import type { Principal } from '../rbac/index.js';

let t: TestDb; let org: string; let engine: MembershipEngine; let svc: AudienceService; let dist: DistributionEngine; let principal: Principal;
let registry: DestinationRegistry; let meta: MockMetaAdapter; let google: MockGoogleAdapter; let queue: PgJobQueue;
const NOW = new Date('2026-08-23T12:00:00Z');
const d = (days: number) => new Date(NOW.getTime() - days * 86400_000);
const cond = (field: string, operator: string, value?: unknown, params?: Record<string, unknown>) => ({ type: 'condition' as const, field, operator, value, params });
const and = (...children: unknown[]) => ({ type: 'group' as const, operator: 'AND' as const, children }) as never;

async function addCustomer(s: Parameters<typeof insertCustomer>[2] & { email?: string | null; phone?: string | null } = {}) {
  const id = await insertCustomer(t.db, org, s);
  const email = s.email === undefined ? (await t.db.selectFrom('customers').select('email_hash').where('id', '=', id).executeTakeFirstOrThrow()).email_hash : s.email ? sha256(s.email.toLowerCase()) : null;
  const rows = [];
  if (email) rows.push({ organization_id: org, customer_id: id, kind: 'EMAIL', hash_profile: 'EMAIL_SHA256', hash: email }, { organization_id: org, customer_id: id, kind: 'EMAIL', hash_profile: 'EMAIL_SHA256_GOOGLE', hash: sha256('g:' + email.toString('hex')) });
  if (s.phone) rows.push({ organization_id: org, customer_id: id, kind: 'PHONE', hash_profile: 'PHONE_E164_SHA256', hash: sha256(s.phone) }, { organization_id: org, customer_id: id, kind: 'PHONE', hash_profile: 'PHONE_DIGITS_SHA256', hash: sha256(s.phone.replace('+', '')) });
  if (rows.length) await t.db.insertInto('customer_identifiers').values(rows).execute();
  return id;
}
async function connectDestination(type: 'MOCK_META' | 'MOCK_GOOGLE') {
  const dest = await t.db.insertInto('destinations').values({ organization_id: org, type, name: type, status: 'CONNECTED', credential_ref: 'secret://mock', config: '{}' }).returning('id').executeTakeFirstOrThrow();
  const acct = await t.db.insertInto('destination_accounts').values({ destination_id: dest.id, organization_id: org, external_account_id: type === 'MOCK_META' ? 'act_1' : '1234567890', name: 'Main' }).returning('id').executeTakeFirstOrThrow();
  return { destinationId: dest.id, accountId: acct.id };
}
const adOf = async (audienceId: string, accountId: string) => t.db.selectFrom('audience_destinations').selectAll().where('audience_id', '=', audienceId).where('destination_account_id', '=', accountId).executeTakeFirstOrThrow();
const emailHashOf = async (id: number) => (await t.db.selectFrom('customers').select('email_hash').where('id', '=', id).executeTakeFirstOrThrow()).email_hash!.toString('hex');

beforeAll(async () => {
  t = await createTestDb(); queue = new PgJobQueue(t.db); engine = new MembershipEngine(t.db); svc = new AudienceService(t.db, queue);
});
beforeEach(async () => {
  await t.truncateAll(); MockDestinationAdapter.reset();
  org = await createOrg(t.db); principal = { type: 'USER', id: null, label: 'test', organizationId: org, role: 'ADMIN' };
  registry = new DestinationRegistry('mock'); meta = registry.get('MOCK_META') as MockMetaAdapter; google = registry.get('MOCK_GOOGLE') as MockGoogleAdapter;
  const secrets = new MemorySecretStore(); await secrets.put('secret://mock', 'token');
  dist = new DistributionEngine({ db: t.db, queue, secrets, registry });
  await t.db.insertInto('compliance_policies').values({ organization_id: org, name: 'default', is_default: true, rules: '{}' }).execute();
});
afterAll(async () => { await t.close(); });

describe('distribution engine', () => {
  it('activates, syncs eligible members only, then removes on purchase and opt-out (delta only)', async () => {
    const c1 = await addCustomer({ has_open_cart: true, last_cart_at: d(2) });
    const c2 = await addCustomer({ has_open_cart: true, last_cart_at: d(2), phone: '+919876543210' });
    const cNoConsent = await addCustomer({ has_open_cart: true, last_cart_at: d(2), consent_status: 'DENIED', advertising_personalization_allowed: false });
    const cSupp = await addCustomer({ has_open_cart: true, last_cart_at: d(2), suppressed: true });
    const cNoId = await addCustomer({ has_open_cart: true, last_cart_at: d(2), email: null });
    const { id: aud } = await svc.create(principal, { name: 'Cart 1-3d', templateKey: 'CART_ABANDONER', status: 'ACTIVE' });
    await engine.evaluate(aud, { mode: 'FULL', now: NOW });
    const { accountId } = await connectDestination('MOCK_META');
    const act = await dist.activate(principal, aud, { destinationAccountIds: [accountId] });
    expect(act.dryRun).toBe(false);
    const ad = await adOf(aud, accountId);
    const r1 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'INITIAL', now: NOW });
    expect(r1.status).toBe('SUCCESS');
    expect(r1).toMatchObject({ sourceCount: 5, eligibleCount: 2, added: 2, removed: 0 });
    expect(r1.funnel).toMatchObject({ suppressed: 1, consentDenied: 1, noIdentifier: 1 });
    const ad1 = await adOf(aud, accountId);
    expect(ad1.external_audience_id).toBeTruthy(); expect(ad1.status).toBe('ACTIVE'); expect(Number(ad1.submitted_count)).toBe(2);
    expect(ad1.matched_lower).not.toBeNull();
    const members = meta.membersOf(ad1.external_audience_id!);
    expect(members.has(await emailHashOf(c1))).toBe(true);
    expect(members.has(sha256('919876543210').toString('hex'))).toBe(true); // Meta digits profile
    void cNoConsent; void cSupp; void cNoId;

    // nothing changed → second sync sends nothing
    const callsBefore = meta.calls.length;
    const r2 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'SCHEDULED', now: new Date(NOW.getTime() + 3600_000) });
    expect(r2).toMatchObject({ added: 0, removed: 0, batchesTotal: 0 });
    expect(meta.calls.length).toBe(callsBefore);

    // c1 purchases → exits audience → REMOVE; c3 new abandoner → ADD
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    await t.db.updateTable('customers').set({ has_open_cart: false, order_count: 1, last_order_at: later, updated_at: later }).where('id', '=', c1).execute();
    const c3 = await addCustomer({ has_open_cart: true, last_cart_at: d(1.5), updated_at: later });
    await engine.evaluate(aud, { now: new Date(later.getTime() + 60_000) });
    const r3 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'SCHEDULED', now: new Date(later.getTime() + 120_000) });
    expect(r3).toMatchObject({ added: 1, removed: 1 });
    const m3 = meta.membersOf(ad1.external_audience_id!);
    expect(m3.has(await emailHashOf(c1))).toBe(false); expect(m3.has(await emailHashOf(c3))).toBe(true);
    const states = await t.db.selectFrom('audience_destination_members').select(['customer_id', 'state']).where('audience_destination_id', '=', ad.id).orderBy('customer_id').execute();
    expect(states.find((s) => s.customer_id === c1)!.state).toBe('REMOVED');
    expect(states.find((s) => s.customer_id === c2)!.state).toBe('SYNCED');

    // c2 opts out → suppressed (no rule change) → suppression sweep → REMOVE
    await t.db.updateTable('customers').set({ suppressed: true, suppressed_at: new Date(), updated_at: new Date() }).where('id', '=', c2).execute();
    expect(await dist.sweepSuppressed(org, null)).toBe(1);
    const r4 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'SUPPRESSION', now: new Date(later.getTime() + 240_000) });
    expect(r4.removed).toBe(1);
    expect(meta.membersOf(ad1.external_audience_id!).has(await emailHashOf(c2))).toBe(false);
    const job = await t.db.selectFrom('sync_jobs').selectAll().where('id', '=', r4.jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('SUCCESS'); expect(job.trigger).toBe('SUPPRESSION');
  });

  it('retries rate limits and transient errors; invalid batches fail with warnings; auth expiry pauses the job and flags the destination', async () => {
    for (let i = 0; i < 25; i++) await addCustomer({ lifetime_value: 20000 });
    const { id: aud } = await svc.create(principal, { name: 'HV', definition: and(cond('lifetime_value', 'gte', 10000)), status: 'ACTIVE' });
    await engine.evaluate(aud, { mode: 'FULL', now: NOW });
    const { accountId, destinationId } = await connectDestination('MOCK_META');
    // force small batches through a custom adapter instance with maxBatchSize 10
    const small = new MockMetaAdapter(); (small.capabilities as { maxBatchSize: number }).maxBatchSize = 10; registry.register('MOCK_META', small);
    small.failures = { rateLimitEvery: 2, transientOnSeq: [2], invalidOnSeq: [3] };
    await dist.activate(principal, aud, { destinationAccountIds: [accountId] });
    const ad = await adOf(aud, accountId);
    const r = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'INITIAL', now: NOW });
    expect(r.batchesTotal).toBe(3);
    expect(r.status).toBe('SUCCESS_WITH_WARNINGS');
    expect(r.added).toBe(20); expect(r.failed).toBe(5);
    const batches = await t.db.selectFrom('sync_job_batches').select(['seq', 'status', 'attempts', 'error_code']).where('sync_job_id', '=', r.jobId).orderBy('seq').execute();
    expect(batches.map((b) => b.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'FAILED']);
    expect(batches[1]!.attempts).toBeGreaterThan(1);
    expect(batches[2]!.error_code).toMatch(/INVALID_REQUEST/);
    expect((await t.db.selectFrom('audience_destination_members').select('state').where('audience_destination_id', '=', ad.id).where('state', '=', 'FAILED').execute()).length).toBe(5);
    // retry the job: failed batch becomes PENDING and succeeds once the failure plan is cleared
    small.failures = {};
    await dist.retryJob(principal, r.jobId);
    const r2 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'RETRY', resumeJobId: r.jobId, now: NOW });
    expect(r2.status).toBe('SUCCESS'); expect(r2.added).toBe(25);
    // auth expiry
    small.failures = { authExpired: true };
    await addCustomer({ lifetime_value: 50000, updated_at: new Date(NOW.getTime() + 60_000) }); await engine.evaluate(aud, { now: new Date(NOW.getTime() + 120_000) });
    const r3 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'SCHEDULED', now: new Date(NOW.getTime() + 180_000) });
    expect(r3.status).toBe('PAUSED');
    expect((await t.db.selectFrom('destinations').select('status').where('id', '=', destinationId).executeTakeFirstOrThrow()).status).toBe('ERROR');
    expect((await adOf(aud, accountId)).status).toBe('ERROR');
  });

  it('exclusions, holdout, dry run and Google hash profiles', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) ids.push(await addCustomer({ lifetime_value: 20000, last_order_at: i < 10 ? d(1) : d(100) }));
    const { id: recent } = await svc.create(principal, { name: 'Recent', templateKey: 'RECENT_PURCHASER', status: 'ACTIVE' });
    const { id: hv } = await svc.create(principal, { name: 'HV', definition: and(cond('lifetime_value', 'gte', 10000)), excludeAudienceIds: [recent], holdoutPercent: 20, status: 'ACTIVE' });
    await engine.evaluate(recent, { mode: 'FULL', now: NOW }); await engine.evaluate(hv, { mode: 'FULL', now: NOW });
    const { accountId } = await connectDestination('MOCK_GOOGLE');
    // dry run → no remote calls, no member state
    const dry = await dist.activate(principal, hv, { destinationAccountIds: [accountId], dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.reports![0]!.funnel).toMatchObject({ total: 50, excludedByAudience: 10 });
    expect(dry.reports![0]!.estimatedPayload.identifierProfiles.EMAIL).toBe('EMAIL_SHA256_GOOGLE');
    expect((await t.db.selectFrom('audience_destinations').selectAll().execute()).length).toBe(0);
    // real activation
    await dist.activate(principal, hv, { destinationAccountIds: [accountId] });
    const ad = await adOf(hv, accountId);
    const r = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'INITIAL', now: NOW });
    expect(r.sourceCount).toBe(50); expect(r.funnel.excludedByAudience).toBe(10);
    expect(r.funnel.holdout).toBeGreaterThan(0); expect(r.funnel.holdout).toBeLessThan(20);
    expect(r.added).toBe(40 - r.funnel.holdout!);
    const ho = await t.db.selectFrom('holdout_assignments').select('group').where('audience_id', '=', hv).execute();
    expect(ho.filter((h) => h.group === 'CONTROL').length).toBe(r.funnel.holdout);
    // google received the google-normalized email hash, not the canonical one
    const mem = google.membersOf((await adOf(hv, accountId)).external_audience_id!);
    const c = (await t.db.selectFrom('holdout_assignments').select('customer_id').where('audience_id', '=', hv).where('group', '=', 'TREATMENT').orderBy('customer_id').executeTakeFirstOrThrow()).customer_id; const canonical = await emailHashOf(c);
    expect(mem.has(canonical)).toBe(false);
    expect(mem.has(sha256('g:' + canonical).toString('hex'))).toBe(true);
    const adRow = await adOf(hv, accountId);
    expect(adRow.match_rate).not.toBeNull();
    // pause → scheduled sync is skipped; archive → REMOVE_ALL + delete remote
    await dist.pause(principal, hv);
    const skipped = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'SCHEDULED', now: NOW });
    expect(skipped.status).toBe('SKIPPED_PAUSED');
    await dist.resume(principal, hv);
    await svc.update(principal, hv, { status: 'ARCHIVED' });
    await dist.onAudienceStatusChanged(org, hv, 'ARCHIVED');
    const ra = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'MANUAL', mode: 'REMOVE_ALL', now: NOW });
    expect(ra.removed).toBe(r.added);
    expect((await adOf(hv, accountId)).status).toBe('DELETED');
    expect(google.calls.some((x) => x.op === 'deleteAudience')).toBe(true);
  });
});
