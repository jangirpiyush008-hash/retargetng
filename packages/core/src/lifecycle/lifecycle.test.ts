import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, type TestDb } from '@aap/db/test-utils';
import { computeLifecycleState, lifecycleStateSql } from './index.js';
import { createOrg, insertCustomer } from '../testing/fixtures.js';

describe('lifecycle state machine', () => {
  const NOW = new Date('2026-08-23T12:00:00Z');
  const d = (days: number) => new Date(NOW.getTime() - days * 86400_000);
  it('transitions by data and time', () => {
    expect(computeLifecycleState({ order_count: 0, last_order_at: null, has_open_cart: false, lifetime_value: 0 }, NOW)).toBe('PROSPECT');
    expect(computeLifecycleState({ order_count: 0, last_order_at: null, has_open_cart: true, lifetime_value: 0 }, NOW)).toBe('CART_ABANDONER');
    expect(computeLifecycleState({ order_count: 1, last_order_at: d(3), has_open_cart: false, lifetime_value: 500 }, NOW)).toBe('PURCHASER');
    expect(computeLifecycleState({ order_count: 2, last_order_at: d(3), has_open_cart: false, lifetime_value: 500 }, NOW)).toBe('REPEAT_PURCHASER');
    expect(computeLifecycleState({ order_count: 5, last_order_at: d(3), has_open_cart: false, lifetime_value: 50000 }, NOW)).toBe('VIP');
    expect(computeLifecycleState({ order_count: 5, last_order_at: d(31), has_open_cart: false, lifetime_value: 50000 }, NOW)).toBe('INACTIVE_30D');
    expect(computeLifecycleState({ order_count: 1, last_order_at: d(61), has_open_cart: false, lifetime_value: 1 }, NOW)).toBe('INACTIVE_60D');
    expect(computeLifecycleState({ order_count: 1, last_order_at: d(91), has_open_cart: false, lifetime_value: 1 }, NOW)).toBe('LAPSED_90D');
    expect(computeLifecycleState({ order_count: 1, last_order_at: d(181), has_open_cart: false, lifetime_value: 1 }, NOW)).toBe('LAPSED_180D');
    expect(computeLifecycleState({ order_count: 1, last_order_at: d(366), has_open_cart: false, lifetime_value: 1 }, NOW)).toBe('LAPSED_365D');
  });
  it('SQL twin agrees with TS', async () => {
    const t: TestDb = await createTestDb(); await t.truncateAll();
    const org = await createOrg(t.db);
    const cases = [
      { order_count: 0, has_open_cart: false }, { order_count: 0, has_open_cart: true },
      { order_count: 1, last_order_at: d(3), lifetime_value: 100 }, { order_count: 3, last_order_at: d(10), lifetime_value: 100 },
      { order_count: 3, last_order_at: d(10), lifetime_value: 30000 }, { order_count: 1, last_order_at: d(45) },
      { order_count: 1, last_order_at: d(75) }, { order_count: 1, last_order_at: d(100) }, { order_count: 1, last_order_at: d(200) }, { order_count: 1, last_order_at: d(400) },
    ];
    for (const c of cases) await insertCustomer(t.db, org, c);
    const rows = await sql<{ id: number; order_count: number; last_order_at: Date | null; has_open_cart: boolean; lifetime_value: number; sql_state: string }>`
      SELECT c.id, c.order_count, c.last_order_at, c.has_open_cart, c.lifetime_value, ${lifecycleStateSql(NOW)} AS sql_state FROM customers c WHERE c.organization_id = ${org}`.execute(t.db);
    for (const r of rows.rows) expect(r.sql_state).toBe(computeLifecycleState(r, NOW));
    await t.close();
  });
});
