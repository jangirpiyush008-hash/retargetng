import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, type TestDb } from '@aap/db/test-utils';
import { compileRule, validateRuleDefinition, parseRuleDefinition, describeRule, type RuleDefinition } from './index.js';
import { createOrg, insertCustomer } from '../testing/fixtures.js';

let t: TestDb; let org: string;
const NOW = new Date('2026-08-23T12:00:00Z');
const d = (days: number) => new Date(NOW.getTime() - days * 86400_000);

async function matches(def: RuleDefinition): Promise<number[]> {
  const c = compileRule(parseRuleDefinition(def), { now: NOW, organizationId: org });
  const r = await sql<{ id: number }>`SELECT c.id FROM customers c WHERE c.organization_id = ${org} AND ${c.predicate} ORDER BY c.id`.execute(t.db);
  return r.rows.map((x) => x.id);
}
const cond = (field: string, operator: string, value?: unknown, params?: Record<string, unknown>) => ({ type: 'condition' as const, field, operator, value, params });
const and = (...children: unknown[]) => ({ type: 'group' as const, operator: 'AND' as const, children }) as RuleDefinition;
const or = (...children: unknown[]) => ({ type: 'group' as const, operator: 'OR' as const, children }) as RuleDefinition;

let ids: Record<string, number> = {};
beforeAll(async () => {
  t = await createTestDb();
  await t.truncateAll();
  org = await createOrg(t.db);
  ids = {
    highValue: await insertCustomer(t.db, org, { total_revenue: 15000, lifetime_value: 15000, order_count: 4, last_order_at: d(200), first_order_at: d(500), country: 'IN' }),
    recent: await insertCustomer(t.db, org, { total_revenue: 2000, order_count: 1, last_order_at: d(2), first_order_at: d(2), country: 'US' }),
    cart2d: await insertCustomer(t.db, org, { has_open_cart: true, last_cart_at: d(2), country: 'IN', attributes: { tier: 'gold', score: '42' } }),
    cart5d: await insertCustomer(t.db, org, { has_open_cart: true, last_cart_at: d(5), country: 'IN' }),
    prospect: await insertCustomer(t.db, org, { country: 'DE', lifecycle_state: 'PROSPECT' }),
  };
  const [p1, p2] = await t.db.insertInto('products').values([
    { organization_id: org, external_product_id: 'shoes', name: 'Running Shoes' },
    { organization_id: org, external_product_id: 'socks', name: 'Running Socks' },
  ]).returning('id').execute();
  ids.shoes = p1!.id; ids.socks = p2!.id;
  await t.db.insertInto('customer_product_purchases').values([
    { organization_id: org, customer_id: ids.highValue!, product_id: ids.shoes!, first_purchased_at: d(200), last_purchased_at: d(200), purchase_count: 2, quantity: 2, revenue: 8000 },
    { organization_id: org, customer_id: ids.recent!, product_id: ids.shoes!, first_purchased_at: d(2), last_purchased_at: d(2), purchase_count: 1, quantity: 1, revenue: 2000 },
    { organization_id: org, customer_id: ids.recent!, product_id: ids.socks!, first_purchased_at: d(2), last_purchased_at: d(2), purchase_count: 1, quantity: 1, revenue: 300 },
  ]).execute();
  await t.db.insertInto('customer_product_interactions').values([
    { organization_id: org, customer_id: ids.cart2d!, product_id: ids.shoes!, interaction: 'CARTED', first_at: d(2), last_at: d(2), count: 1 },
  ]).execute();
});
afterAll(async () => { await t.close(); });

describe('rule schema', () => {
  it('rejects unknown fields and bad operators', () => {
    expect(validateRuleDefinition(and(cond('nope', 'eq', 1))).ok).toBe(false);
    expect(validateRuleDefinition(and(cond('total_revenue', 'contains', 'x'))).ok).toBe(false);
    expect(validateRuleDefinition(and(cond('last_order_at', 'within_last', { value: 7 }))).ok).toBe(false);
    expect(validateRuleDefinition({ type: 'group', operator: 'AND', children: [] }).ok).toBe(false);
  });
  it('accepts well-formed rules', () => {
    expect(validateRuleDefinition(and(cond('total_revenue', 'gte', 10000), cond('order_count', 'gte', 3))).ok).toBe(true);
  });
});

describe('rule compiler (executed against Postgres)', () => {
  it('high value customers: total_revenue >= 10000 AND order_count >= 3', async () => {
    expect(await matches(and(cond('total_revenue', 'gte', 10000), cond('order_count', 'gte', 3)))).toEqual([ids.highValue]);
  });
  it('lapsed: order_count >= 1 AND last_order_at more than 180 days ago', async () => {
    expect(await matches(and(cond('order_count', 'gte', 1), cond('last_order_at', 'more_than_ago', { value: 180, unit: 'days' })))).toEqual([ids.highValue]);
  });
  it('recent purchasers within last 7 days', async () => {
    expect(await matches(and(cond('last_order_at', 'within_last', { value: 7, unit: 'days' })))).toEqual([ids.recent]);
  });
  it('cart abandoners 1–3 days', async () => {
    expect(await matches(and(cond('has_open_cart', 'eq', true), cond('last_cart_at', 'between_ago', { min: 1, max: 3, unit: 'days' })))).toEqual([ids.cart2d]);
    expect(await matches(and(cond('has_open_cart', 'eq', true), cond('last_cart_at', 'between_ago', { min: 4, max: 7, unit: 'days' })))).toEqual([ids.cart5d]);
  });
  it('nested boolean logic with NOT group', async () => {
    // (revenue > 1000) AND NOT (purchased in last 30 days)
    const def = and(cond('total_revenue', 'gt', 1000), { type: 'group', operator: 'OR', negate: true, children: [cond('last_order_at', 'within_last', { value: 30, unit: 'days' })] });
    expect(await matches(def)).toEqual([ids.highValue]);
  });
  it('OR groups and IN lists', async () => {
    expect(await matches(or(cond('country', 'in', ['US', 'DE'])))).toEqual([ids.recent, ids.prospect]);
    expect(await matches(and(cond('country', 'not_in', ['IN'])))).toEqual([ids.recent, ids.prospect]);
  });
  it('product-level: bought shoes but not socks (cross-sell)', async () => {
    expect(await matches(and(cond('product_purchased', 'in', [ids.shoes]), cond('product_purchased', 'not_in', [ids.socks])))).toEqual([ids.highValue]);
    expect(await matches(and(cond('product_purchased', 'in', [ids.shoes], { withinDays: 30 })))).toEqual([ids.recent]);
    expect(await matches(and(cond('product_purchased', 'in', [ids.shoes], { minCount: 2 })))).toEqual([ids.highValue]);
    expect(await matches(and(cond('product_purchased', 'any')))).toEqual([ids.highValue, ids.recent]);
    expect(await matches(and(cond('product_purchased', 'none')))).toEqual([ids.cart2d, ids.cart5d, ids.prospect]);
  });
  it('carted product with openOnly', async () => {
    expect(await matches(and(cond('product_carted', 'in', [ids.shoes], { openOnly: true })))).toEqual([ids.cart2d]);
  });
  it('custom attributes', async () => {
    expect(await matches(and(cond('attribute_text', 'eq', 'gold', { path: 'tier' })))).toEqual([ids.cart2d]);
    expect(await matches(and(cond('attribute_number', 'gte', 40, { path: 'score' })))).toEqual([ids.cart2d]);
  });
  it('in_audience dependency compiles and is tracked', async () => {
    const aud = await t.db.insertInto('audiences').values({ organization_id: org, name: 'A', slug: 'A_' + Date.now() }).returning('id').executeTakeFirstOrThrow();
    await t.db.insertInto('audience_members').values({ audience_id: aud.id, customer_id: ids.prospect!, organization_id: org, status: 'ACTIVE', entered_at: NOW, last_evaluated_at: NOW, rule_version: 1 }).execute();
    const def = and(cond('in_audience', 'in', [aud.id]));
    expect(await matches(def)).toEqual([ids.prospect]);
    expect(compileRule(def, { now: NOW, organizationId: org }).dependencies.audienceIds).toEqual([aud.id]);
  });
  it('extracts time bands for incremental candidate extraction', () => {
    const c = compileRule(and(cond('last_order_at', 'more_than_ago', { value: 180, unit: 'days' }), cond('last_cart_at', 'between_ago', { min: 1, max: 3, unit: 'days' }),
      cond('product_purchased', 'in', [1], { withinDays: 30 })), { now: NOW, organizationId: org });
    expect(c.timeBands).toEqual([
      { table: 'customers', column: 'last_order_at', offsetSeconds: 180 * 86400 },
      { table: 'customers', column: 'last_cart_at', offsetSeconds: 86400 },
      { table: 'customers', column: 'last_cart_at', offsetSeconds: 3 * 86400 },
      { table: 'customer_product_purchases', column: 'last_purchased_at', offsetSeconds: 30 * 86400, filter: { column: 'product_id', values: [1] } },
    ]);
    expect(c.conditionCount).toBe(3);
  });
  it('describes rules for humans', () => {
    expect(describeRule(and(cond('total_revenue', 'gte', 10000), cond('last_order_at', 'more_than_ago', { value: 180, unit: 'days' }))))
      .toBe('(Total spend ≥ 10,000 AND Last purchase more than 180 days ago)');
  });
});
