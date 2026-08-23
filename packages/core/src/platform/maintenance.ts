import { sql, type Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { lifecycleStateSql, DEFAULT_LIFECYCLE, type LifecycleThresholds } from '../lifecycle/index.js';
import { logger } from '../observability/logger.js';

/** Time-driven maintenance: lifecycle transitions, daily counters, retention, partitions. */
export class MaintenanceService {
  private log = logger().child({ module: 'maintenance' });
  constructor(private db: Kysely<DB>) {}

  /**
   * Lifecycle states that change purely with time (INACTIVE_30D → … → LAPSED_365D). Only customers whose
   * last_order_at crossed a boundary inside (since, now] are touched — never a full scan.
   */
  async applyLifecycleTimeTransitions(org: string, since: Date, now: Date, t: LifecycleThresholds = DEFAULT_LIFECYCLE): Promise<number> {
    let changed = 0;
    for (const days of [30, 60, 90, 180, 365]) {
      const r = await sql<{ n: number }>`
        WITH cand AS (
          SELECT c.id, ${lifecycleStateSql(now, t)} AS new_state FROM customers c
          WHERE c.organization_id = ${org} AND c.last_order_at > ${since}::timestamptz - make_interval(days => ${days}) AND c.last_order_at <= ${now}::timestamptz - make_interval(days => ${days})
        ), up AS (
          UPDATE customers c SET lifecycle_state = cand.new_state, lifecycle_state_changed_at = ${now}, updated_at = ${now}
          FROM cand WHERE c.id = cand.id AND c.lifecycle_state IS DISTINCT FROM cand.new_state RETURNING 1
        ) SELECT count(*)::int AS n FROM up`.execute(this.db);
      changed += r.rows[0]?.n ?? 0;
    }
    return changed;
  }

  /** Reset per-day counters (run once per UTC day). */
  async resetDailyCounters(): Promise<void> {
    await this.db.updateTable('audiences').set({ added_today: 0, removed_today: 0 }).execute();
  }

  /** Ensure rolling monthly partitions exist for the next 3 months. */
  async ensurePartitions(): Promise<void> {
    for (const table of ['customer_events', 'cart_events', 'audience_membership_history', 'sync_job_batches']) {
      await sql`SELECT ensure_monthly_partitions(${table}, (now() - interval '1 month')::date, (now() + interval '3 months')::date)`.execute(this.db);
    }
  }

  /** Apply org retention policies: drop expired partitions and delete expired rows. */
  async applyRetention(org: string): Promise<Record<string, number>> {
    const policies = await this.db.selectFrom('retention_policies').select(['data_class', 'retention_days']).where('organization_id', '=', org).execute();
    const days = Object.fromEntries(policies.map((p) => [p.data_class, p.retention_days]));
    const out: Record<string, number> = {};
    const del = async (key: string, q: () => Promise<{ numDeletedRows?: bigint; numAffectedRows?: bigint }>) => { if (days[key]) { const r = await q(); out[key] = Number(r.numDeletedRows ?? r.numAffectedRows ?? 0); } };
    const cutoff = (key: string) => new Date(Date.now() - days[key]! * 86400_000);
    await del('raw_events', () => this.db.deleteFrom('customer_events').where('organization_id', '=', org).where('occurred_at', '<', cutoff('raw_events')).executeTakeFirst());
    await del('cart_events', () => this.db.deleteFrom('cart_events').where('organization_id', '=', org).where('occurred_at', '<', cutoff('cart_events')).executeTakeFirst());
    await del('membership_history', () => this.db.deleteFrom('audience_membership_history').where('organization_id', '=', org).where('occurred_at', '<', cutoff('membership_history')).executeTakeFirst());
    await del('sync_batches', () => this.db.deleteFrom('sync_job_batches').where('organization_id', '=', org).where('created_at', '<', cutoff('sync_batches')).executeTakeFirst());
    await del('audit_logs', () => this.db.deleteFrom('audit_logs').where('organization_id', '=', org).where('occurred_at', '<', cutoff('audit_logs')).executeTakeFirst());
    await del('eval_runs', () => this.db.deleteFrom('audience_eval_runs').where('organization_id', '=', org).where('started_at', '<', cutoff('eval_runs')).executeTakeFirst());
    await del('sessions', () => this.db.deleteFrom('sessions').where('expires_at', '<', new Date()).executeTakeFirst());
    // deleted customers: purge rows entirely after the window (hash tombstones remain in suppression_records)
    await del('deleted_customers', () => this.db.deleteFrom('customers').where('organization_id', '=', org).where('deleted', '=', true).where('deleted_at', '<', cutoff('deleted_customers')).executeTakeFirst());
    // whole-partition drops when an entire month is older than the longest relevant retention
    const maxDays = Math.max(days.raw_events ?? 0, days.cart_events ?? 0);
    if (maxDays) {
      const parts = await sql<{ relname: string }>`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname IN ('customer_events','cart_events') AND c.relname ~ '_[0-9]{6}$'`.execute(this.db);
      for (const p of parts.rows) {
        const ym = p.relname.slice(-6); const end = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(4, 6)), 1));
        if (end.getTime() < Date.now() - maxDays * 86400_000) {
          const other = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.raw(p.relname)} WHERE organization_id <> ${org}`.execute(this.db);
          if ((other.rows[0]?.n ?? 0) === 0) { await sql`DROP TABLE IF EXISTS ${sql.raw(p.relname)}`.execute(this.db); out[`dropped:${p.relname}`] = 1; }
        }
      }
    }
    this.log.info({ org, out }, 'retention applied');
    return out;
  }
}
