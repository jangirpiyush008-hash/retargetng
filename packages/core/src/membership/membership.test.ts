import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '@aap/db/test-utils';
import { MembershipEngine } from './engine.js';
import { AudienceService } from '../audience/service.js';
import { PgJobQueue } from '../queue/pg-queue.js';
import { createOrg, insertCustomer } from '../testing/fixtures.js';
import type { Principal } from '../rbac/index.js';

let t: TestDb; let org: string; let engine: MembershipEngine; let svc: AudienceService; let principal: Principal;
const NOW = new Date('2026-08-23T12:00:00Z');
const d = (days: number, base = NOW) => new Date(base.getTime() - days * 86400_000);
const cond = (field: string, operator: string, value?: unknown, params?: Record<string, unknown>) => ({ type: 'condition' as const, field, operator, value, params });
const and = (...children: unknown[]) => ({ type: 'group' as const, operator: 'AND' as const, children }) as never;

const activeMembers = async (aid: string) => (await t.db.selectFrom('audience_members').select('customer_id').where('audience_id', '=', aid).where('status', '=', 'ACTIVE').orderBy('customer_id').execute()).map((r) => r.customer_id);

beforeAll(async () => { t = await createTestDb(); engine = new MembershipEngine(t.db); svc = new AudienceService(t.db, new PgJobQueue(t.db)); });
beforeEach(async () => { await t.truncateAll(); org = await createOrg(t.db); principal = { type: 'USER', id: null, label: 'test', organizationId: org, role: 'ADMIN' }; });
afterAll(async () => { await t.close(); });

describe('membership engine', () => {
  it('FULL evaluation materializes members and INCREMENTAL picks up dirty customers and exits', async () => {
    const a = await insertCustomer(t.db, org, { total_revenue: 20000, lifetime_value: 20000, order_count: 5, updated_at: d(10) });
    const b = await insertCustomer(t.db, org, { total_revenue: 500, lifetime_value: 500, order_count: 1, updated_at: d(10) });
    const { id } = await svc.create(principal, { name: 'High value', definition: and(cond('lifetime_value', 'gte', 10000)), status: 'ACTIVE', evaluationSchedule: 'HOURLY' });
    const r1 = await engine.evaluate(id, { mode: 'FULL', now: NOW });
    expect(r1.entered).toBe(1); expect(await activeMembers(id)).toEqual([a]);
    // b becomes high value (dirty), a drops below threshold (dirty)
    await t.db.updateTable('customers').set({ lifetime_value: 15000, updated_at: new Date(NOW.getTime() + 60_000) }).where('id', '=', b).execute();
    await t.db.updateTable('customers').set({ lifetime_value: 100, updated_at: new Date(NOW.getTime() + 60_000) }).where('id', '=', a).execute();
    const r2 = await engine.evaluate(id, { now: new Date(NOW.getTime() + 120_000) });
    expect(r2.mode).toBe('INCREMENTAL');
    expect(r2.candidates).toBe(2); expect(r2.entered).toBe(1); expect(r2.exited).toBe(1);
    expect(await activeMembers(id)).toEqual([b]);
    const hist = await t.db.selectFrom('audience_membership_history').select(['customer_id', 'action']).where('audience_id', '=', id).orderBy('occurred_at').orderBy('customer_id').execute();
    expect(hist).toEqual([{ customer_id: a, action: 'ENTER' }, { customer_id: a, action: 'EXIT' }, { customer_id: b, action: 'ENTER' }]);
    const aud = await t.db.selectFrom('audiences').select(['member_count', 'last_evaluated_at', 'next_evaluation_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(Number(aud.member_count)).toBe(1);
    expect(aud.next_evaluation_at).not.toBeNull();
  });

  it('time-boundary crossers enter/exit without any customer update (cart abandoners 1–3d)', async () => {
    const base = NOW;
    const c1 = await insertCustomer(t.db, org, { has_open_cart: true, last_cart_at: new Date(base.getTime() - 20 * 3600_000), updated_at: d(5) }); // 20h ago: not yet 1 day
    const c2 = await insertCustomer(t.db, org, { has_open_cart: true, last_cart_at: new Date(base.getTime() - 70 * 3600_000), updated_at: d(5) }); // 70h: in window, will exit at 72h
    const { id } = await svc.create(principal, { name: 'Cart 1-3d', templateKey: 'CART_ABANDONER', templateParams: { minDays: 1, maxDays: 3 }, status: 'ACTIVE' });
    await engine.evaluate(id, { mode: 'FULL', now: base });
    expect(await activeMembers(id)).toEqual([c2]);
    // 6 hours later: c1 crosses 1 day (enters), c2 crosses 3 days (exits). No updated_at changes.
    const later = new Date(base.getTime() + 6 * 3600_000);
    const r = await engine.evaluate(id, { now: later });
    expect(r.mode).toBe('INCREMENTAL');
    expect(r.entered).toBe(1); expect(r.exited).toBe(1);
    expect(await activeMembers(id)).toEqual([c1]);
    // purchase converts c1's cart (dirty) → exits
    await t.db.updateTable('customers').set({ has_open_cart: false, order_count: 1, last_order_at: later, updated_at: new Date(later.getTime() + 1000) }).where('id', '=', c1).execute();
    const r2 = await engine.evaluate(id, { now: new Date(later.getTime() + 3600_000) });
    expect(r2.exited).toBe(1); expect(await activeMembers(id)).toEqual([]);
  });

  it('product-window bands and audience dependencies feed incremental candidates', async () => {
    const p = await t.db.insertInto('products').values({ organization_id: org, external_product_id: 'sku1', name: 'SKU 1' }).returning('id').executeTakeFirstOrThrow();
    const c = await insertCustomer(t.db, org, { order_count: 1, updated_at: d(30) });
    await t.db.insertInto('customer_product_purchases').values({ organization_id: org, customer_id: c, product_id: p.id, first_purchased_at: d(29), last_purchased_at: d(29), purchase_count: 1, quantity: 1, revenue: 100 }).execute();
    const { id: buyers } = await svc.create(principal, { name: 'Recent SKU1 buyers', definition: and(cond('product_purchased', 'in', [p.id], { withinDays: 30 })), status: 'ACTIVE' });
    const { id: dependent } = await svc.create(principal, { name: 'In buyers', definition: and(cond('in_audience', 'in', [buyers])), status: 'ACTIVE' });
    await engine.evaluate(buyers, { mode: 'FULL', now: NOW });
    await engine.evaluate(dependent, { mode: 'FULL', now: NOW });
    expect(await activeMembers(buyers)).toEqual([c]); expect(await activeMembers(dependent)).toEqual([c]);
    // 2 days later the purchase ages out of the 30-day window → exits buyers (band), then dependent (feed)
    const later = d(-2);
    const r1 = await engine.evaluate(buyers, { now: later });
    expect(r1.exited).toBe(1);
    const r2 = await engine.evaluate(dependent, { now: new Date(later.getTime() + 1000) });
    expect(r2.candidates).toBe(1); expect(r2.exited).toBe(1);
  });

  it('RECONCILE repairs drift and priority marks a single primary audience', async () => {
    const c = await insertCustomer(t.db, org, { order_count: 3, total_revenue: 30000, lifetime_value: 30000, last_order_at: d(200), has_open_cart: true, last_cart_at: d(2) });
    const { id: lapsed } = await svc.create(principal, { name: 'Lapsed', templateKey: 'LAPSED_CUSTOMER', templateParams: { days: 180 }, status: 'ACTIVE', priority: 40 });
    const { id: cart } = await svc.create(principal, { name: 'Cart', templateKey: 'CART_ABANDONER', status: 'ACTIVE', priority: 10 });
    await engine.evaluate(lapsed, { mode: 'FULL', now: NOW }); await engine.evaluate(cart, { mode: 'FULL', now: NOW });
    // simulate drift: someone deleted the membership row
    await t.db.deleteFrom('audience_members').where('audience_id', '=', lapsed).execute();
    const r = await engine.evaluate(lapsed, { mode: 'RECONCILE', now: new Date(NOW.getTime() + 1000) });
    expect(r.entered).toBe(1);
    await engine.recomputePrimary(org, null, new Date(NOW.getTime() + 2000));
    const rows = await t.db.selectFrom('audience_members').select(['audience_id', 'is_primary']).where('customer_id', '=', c).execute();
    expect(rows.find((x) => x.audience_id === cart)!.is_primary).toBe(true);
    expect(rows.find((x) => x.audience_id === lapsed)!.is_primary).toBe(false);
  });

  it('preview returns the consent/suppression funnel and exclusions', async () => {
    await insertCustomer(t.db, org, { lifetime_value: 20000 });
    await insertCustomer(t.db, org, { lifetime_value: 20000, suppressed: true });
    await insertCustomer(t.db, org, { lifetime_value: 20000, consent_status: 'DENIED', advertising_personalization_allowed: false });
    await insertCustomer(t.db, org, { lifetime_value: 20000, email: null });
    const recent = await insertCustomer(t.db, org, { lifetime_value: 20000, last_order_at: d(1) });
    const { id: recentAud } = await svc.create(principal, { name: 'Recent', templateKey: 'RECENT_PURCHASER', status: 'ACTIVE' });
    await engine.evaluate(recentAud, { mode: 'FULL', now: NOW });
    expect(await activeMembers(recentAud)).toEqual([recent]);
    const f = await svc.preview(org, { definition: and(cond('lifetime_value', 'gte', 10000)), excludeAudienceIds: [recentAud], holdoutPercent: 0 });
    expect(f).toMatchObject({ total: 5, excludedByAudience: 1, suppressed: 1, consentDenied: 1, noIdentifier: 1, eligible: 1, estimatedActivation: 1, estimated: false });
    expect(f.sql).toContain('c.lifetime_value');
  });
});
