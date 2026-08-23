import { sql, type Kysely } from 'kysely';
import type { DB } from '@aap/db';

export interface QualityCheck { key: string; label: string; count: number; total: number; severity: 'info' | 'warn' | 'error'; weight: number }

/** Data-quality checks over the customer 360. Counts only — never samples of PII. */
export class DataQualityService {
  constructor(private db: Kysely<DB>) {}

  async compute(org: string): Promise<{ score: number; checks: QualityCheck[]; computedAt: Date }> {
    const c = (await sql<Record<string, number>>`
      SELECT count(*)::bigint AS total,
        count(*) FILTER (WHERE email_hash IS NOT NULL AND email_valid = false)::bigint AS invalid_email,
        count(*) FILTER (WHERE phone_hash IS NOT NULL AND phone_valid = false)::bigint AS invalid_phone,
        count(*) FILTER (WHERE email_hash IS NULL AND phone_hash IS NULL)::bigint AS no_identifier,
        count(*) FILTER (WHERE external_customer_id IS NULL)::bigint AS missing_external_id,
        count(*) FILTER (WHERE consent_status = 'UNKNOWN')::bigint AS missing_consent,
        count(*) FILTER (WHERE total_revenue < 0 OR lifetime_value < 0)::bigint AS negative_revenue,
        count(*) FILTER (WHERE first_order_at > last_order_at OR last_order_at > now() + interval '1 day')::bigint AS invalid_dates,
        count(*) FILTER (WHERE order_count > 0 AND last_order_at IS NULL)::bigint AS inconsistent_orders
      FROM customers WHERE organization_id = ${org} AND NOT deleted`.execute(this.db)).rows[0]!;
    const dupEmail = (await sql<{ n: number }>`SELECT coalesce(sum(n - 1),0)::bigint AS n FROM (SELECT count(*) AS n FROM customers WHERE organization_id = ${org} AND NOT deleted AND email_hash IS NOT NULL GROUP BY email_hash HAVING count(*) > 1) d`.execute(this.db)).rows[0]!.n;
    const dupPhone = (await sql<{ n: number }>`SELECT coalesce(sum(n - 1),0)::bigint AS n FROM (SELECT count(*) AS n FROM customers WHERE organization_id = ${org} AND NOT deleted AND phone_hash IS NOT NULL GROUP BY phone_hash HAVING count(*) > 1) d`.execute(this.db)).rows[0]!.n;
    const orders = (await sql<{ total: number; currencies: number; orphan_items: number }>`
      SELECT (SELECT count(*) FROM orders WHERE organization_id = ${org})::bigint AS total,
             (SELECT count(DISTINCT currency) FROM orders WHERE organization_id = ${org})::int AS currencies,
             (SELECT count(*) FROM order_items oi WHERE oi.organization_id = ${org} AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id))::bigint AS orphan_items`.execute(this.db)).rows[0]!;
    const total = Number(c.total) || 1;
    const checks: QualityCheck[] = [
      { key: 'invalid_email', label: 'Invalid email addresses', count: Number(c.invalid_email), total, severity: 'warn', weight: 1 },
      { key: 'invalid_phone', label: 'Invalid phone numbers', count: Number(c.invalid_phone), total, severity: 'warn', weight: 1 },
      { key: 'no_identifier', label: 'Customers without any identifier', count: Number(c.no_identifier), total, severity: 'error', weight: 2 },
      { key: 'missing_external_id', label: 'Missing external customer id', count: Number(c.missing_external_id), total, severity: 'info', weight: 0.5 },
      { key: 'missing_consent', label: 'Unknown consent state', count: Number(c.missing_consent), total, severity: 'warn', weight: 1 },
      { key: 'duplicate_email', label: 'Duplicate identities (email)', count: Number(dupEmail), total, severity: 'warn', weight: 1.5 },
      { key: 'duplicate_phone', label: 'Duplicate identities (phone)', count: Number(dupPhone), total, severity: 'info', weight: 0.5 },
      { key: 'negative_revenue', label: 'Negative revenue', count: Number(c.negative_revenue), total, severity: 'error', weight: 2 },
      { key: 'invalid_dates', label: 'Invalid order dates', count: Number(c.invalid_dates), total, severity: 'error', weight: 2 },
      { key: 'inconsistent_orders', label: 'Order count without last order date', count: Number(c.inconsistent_orders), total, severity: 'error', weight: 2 },
      { key: 'currency_inconsistency', label: 'Multiple currencies in orders', count: Math.max(0, Number(orders.currencies) - 1), total: Math.max(1, Number(orders.total)), severity: 'info', weight: 0.5 },
      { key: 'orphan_order_items', label: 'Orphan order items', count: Number(orders.orphan_items), total: Math.max(1, Number(orders.total)), severity: 'error', weight: 1 },
    ];
    // score: 100 − weighted sum of issue rates (capped)
    const penalty = checks.reduce((s, ch) => s + Math.min(1, ch.count / ch.total) * ch.weight * 10, 0);
    const score = Math.max(0, Math.round((100 - penalty) * 100) / 100);
    const computedAt = new Date();
    await this.db.insertInto('data_quality_snapshots').values({ organization_id: org, score, checks: JSON.stringify(checks), computed_at: computedAt }).execute();
    return { score, checks, computedAt };
  }

  async latest(org: string) {
    const r = await this.db.selectFrom('data_quality_snapshots').selectAll().where('organization_id', '=', org).orderBy('computed_at', 'desc').executeTakeFirst();
    const history = await this.db.selectFrom('data_quality_snapshots').select(['computed_at', 'score']).where('organization_id', '=', org).orderBy('computed_at', 'desc').limit(30).execute();
    return r ? { score: Number(r.score), checks: r.checks as unknown as QualityCheck[], computedAt: r.computed_at, history: history.reverse() } : null;
  }
}
