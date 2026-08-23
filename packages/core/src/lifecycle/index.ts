import { sql, type RawBuilder } from 'kysely';

export const LIFECYCLE_STATES = ['PROSPECT', 'CART_ABANDONER', 'PURCHASER', 'REPEAT_PURCHASER', 'VIP',
  'INACTIVE_30D', 'INACTIVE_60D', 'LAPSED_90D', 'LAPSED_180D', 'LAPSED_365D'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface LifecycleThresholds { vipLifetimeValue: number; repeatOrders: number }
export const DEFAULT_LIFECYCLE: LifecycleThresholds = { vipLifetimeValue: 25_000, repeatOrders: 2 };

export interface LifecycleInput { order_count: number; last_order_at: Date | null; has_open_cart: boolean; lifetime_value: number }

/**
 * Pure state function (the SQL twin is lifecycleStateSql). States are derived from data, so a
 * transition happens automatically whenever the inputs (or time) change:
 *   PROSPECT → CART_ABANDONER → PURCHASER → REPEAT_PURCHASER → VIP
 *   PURCHASER → INACTIVE_30D → INACTIVE_60D → LAPSED_90D → LAPSED_180D → LAPSED_365D
 */
export function computeLifecycleState(c: LifecycleInput, now: Date, t: LifecycleThresholds = DEFAULT_LIFECYCLE): LifecycleState {
  if (c.order_count <= 0 || !c.last_order_at) return c.has_open_cart ? 'CART_ABANDONER' : 'PROSPECT';
  const days = (now.getTime() - c.last_order_at.getTime()) / 86400_000;
  if (days >= 365) return 'LAPSED_365D';
  if (days >= 180) return 'LAPSED_180D';
  if (days >= 90) return 'LAPSED_90D';
  if (days >= 60) return 'INACTIVE_60D';
  if (days >= 30) return 'INACTIVE_30D';
  if (c.lifetime_value >= t.vipLifetimeValue) return 'VIP';
  if (c.order_count >= t.repeatOrders) return 'REPEAT_PURCHASER';
  return 'PURCHASER';
}

/** SQL CASE expression over alias `c` computing the same state (for bulk time-based transitions). */
export function lifecycleStateSql(now: Date, t: LifecycleThresholds = DEFAULT_LIFECYCLE): RawBuilder<string> {
  return sql<string>`(CASE
    WHEN c.order_count <= 0 OR c.last_order_at IS NULL THEN (CASE WHEN c.has_open_cart THEN 'CART_ABANDONER' ELSE 'PROSPECT' END)
    WHEN c.last_order_at <= ${now}::timestamptz - interval '365 days' THEN 'LAPSED_365D'
    WHEN c.last_order_at <= ${now}::timestamptz - interval '180 days' THEN 'LAPSED_180D'
    WHEN c.last_order_at <= ${now}::timestamptz - interval '90 days' THEN 'LAPSED_90D'
    WHEN c.last_order_at <= ${now}::timestamptz - interval '60 days' THEN 'INACTIVE_60D'
    WHEN c.last_order_at <= ${now}::timestamptz - interval '30 days' THEN 'INACTIVE_30D'
    WHEN c.lifetime_value >= ${t.vipLifetimeValue} THEN 'VIP'
    WHEN c.order_count >= ${t.repeatOrders} THEN 'REPEAT_PURCHASER'
    ELSE 'PURCHASER' END)`;
}
