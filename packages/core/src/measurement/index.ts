import { sql, type Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { pct } from '../util/index.js';

/**
 * Measurement: funnel counts (never present source as reach), campaign metrics, and first-party
 * holdout incrementality (treatment vs control measured on our own orders table).
 */
export class MeasurementService {
  constructor(private db: Kysely<DB>) {}

  /** Roll up treatment/control outcomes for an audience for a day window (idempotent upsert). */
  async rollupHoldoutOutcomes(audienceId: string, from: Date, to: Date): Promise<number> {
    const r = await sql<{ n: number }>`
      WITH days AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day),
      grp AS (SELECT h."group", h.customer_id FROM holdout_assignments h WHERE h.audience_id = ${audienceId}::uuid),
      sizes AS (SELECT "group", count(*)::bigint AS customers FROM grp GROUP BY "group"),
      outcomes AS (
        SELECT d.day, g."group", count(DISTINCT o.customer_id) AS converters, count(o.id) AS orders, coalesce(sum(o.total),0) AS revenue
        FROM days d CROSS JOIN grp g LEFT JOIN orders o ON o.customer_id = g.customer_id AND o.status <> 'CANCELLED' AND o.ordered_at >= d.day AND o.ordered_at < d.day + 1
        GROUP BY d.day, g."group"
      ), up AS (
        INSERT INTO audience_outcomes_daily (audience_id, day, "group", customers, converters, orders, revenue)
        SELECT ${audienceId}::uuid, o.day, o."group", s.customers, o.converters, o.orders, o.revenue FROM outcomes o JOIN sizes s ON s."group" = o."group"
        ON CONFLICT (audience_id, day, "group") DO UPDATE SET customers = EXCLUDED.customers, converters = EXCLUDED.converters, orders = EXCLUDED.orders, revenue = EXCLUDED.revenue
        RETURNING 1
      ) SELECT count(*)::int AS n FROM up`.execute(this.db);
    return r.rows[0]?.n ?? 0;
  }

  /** Incrementality read-out: treatment vs control rates over a window. */
  async holdoutReport(audienceId: string, from: Date, to: Date) {
    const rows = await this.db.selectFrom('audience_outcomes_daily').select(['group']).select((eb) => [eb.fn.max('customers').as('customers'), eb.fn.sum<number>('converters').as('converters'), eb.fn.sum<number>('orders').as('orders'), eb.fn.sum<number>('revenue').as('revenue')])
      .where('audience_id', '=', audienceId).where('day', '>=', from).where('day', '<=', to).groupBy('group').execute();
    const g = (name: string) => { const r = rows.find((x) => x.group === name); return { customers: Number(r?.customers ?? 0), converters: Number(r?.converters ?? 0), orders: Number(r?.orders ?? 0), revenue: Number(r?.revenue ?? 0) }; };
    const t = g('TREATMENT'), c = g('CONTROL');
    const rate = (x: typeof t) => (x.customers ? x.converters / x.customers : 0);
    const rpc = (x: typeof t) => (x.customers ? x.revenue / x.customers : 0);
    const aov = (x: typeof t) => (x.orders ? x.revenue / x.orders : 0);
    const liftRate = rate(t) - rate(c);
    const incrementalConversions = Math.round(liftRate * t.customers);
    const incrementalRevenue = (rpc(t) - rpc(c)) * t.customers;
    // two-proportion z-test for conversion rate
    const p = (t.converters + c.converters) / Math.max(1, t.customers + c.customers);
    const se = Math.sqrt(p * (1 - p) * (1 / Math.max(1, t.customers) + 1 / Math.max(1, c.customers)));
    const z = se > 0 ? liftRate / se : 0;
    const significant = Math.abs(z) >= 1.96 && t.customers >= 100 && c.customers >= 100;
    return {
      treatment: { ...t, conversionRate: rate(t), revenuePerCustomer: rpc(t), aov: aov(t) },
      control: { ...c, conversionRate: rate(c), revenuePerCustomer: rpc(c), aov: aov(c) },
      lift: { conversionRate: liftRate, relative: rate(c) > 0 ? liftRate / rate(c) : null, incrementalConversions, incrementalRevenue, zScore: z, significant, note: significant ? 'Difference is statistically significant at 95%' : 'Not statistically significant — collect more data before drawing conclusions' },
    };
  }

  /** Per-audience campaign metrics (spend, revenue, ROAS, CPA, CTR, CVR) from linked campaigns. */
  async audienceCampaignMetrics(org: string, audienceId: string, from: Date, to: Date) {
    const r = await sql<{ impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number; reach: number | null; campaigns: number }>`
      SELECT coalesce(sum(m.impressions),0)::bigint AS impressions, coalesce(sum(m.clicks),0)::bigint AS clicks, coalesce(sum(m.spend),0) AS spend, coalesce(sum(m.conversions),0)::bigint AS conversions,
             coalesce(sum(m.conversion_value),0) AS conversion_value, max(m.reach) AS reach, count(DISTINCT c.id)::int AS campaigns
      FROM campaign_audiences ca JOIN campaigns c ON c.id = ca.campaign_id AND c.organization_id = ${org}
      LEFT JOIN campaign_metrics_daily m ON m.campaign_id = c.id AND m.day BETWEEN ${from.toISOString().slice(0, 10)}::date AND ${to.toISOString().slice(0, 10)}::date
      WHERE ca.audience_id = ${audienceId}::uuid`.execute(this.db);
    const x = r.rows[0]!;
    const spend = Number(x.spend), rev = Number(x.conversion_value), conv = Number(x.conversions), clicks = Number(x.clicks), imp = Number(x.impressions);
    return { campaigns: x.campaigns, impressions: imp, clicks, spend, conversions: conv, revenue: rev, reach: x.reach, roas: spend > 0 ? rev / spend : null, cpa: conv > 0 ? spend / conv : null, ctr: pct(clicks, imp), cvr: pct(conv, clicks), aov: conv > 0 ? rev / conv : null };
  }

  /**
   * Heavy customer counts → organization_stats snapshot. Run by the worker (hourly) and on demand;
   * the dashboard reads the snapshot so page views never scan the customers table.
   */
  async refreshCustomerStats(org: string) {
    const started = Date.now();
    const r = (await sql<{ total: number; eligible: number; suppressed: number; consent_granted: number; consent_denied: number; consent_unknown: number; in_audiences: number }>`
      SELECT (SELECT count(*) FROM customers WHERE organization_id = ${org} AND NOT deleted)::bigint AS total,
             (SELECT count(*) FROM customers WHERE organization_id = ${org} AND NOT deleted AND NOT suppressed AND consent_status = 'GRANTED' AND advertising_personalization_allowed AND data_sharing_allowed AND (email_hash IS NOT NULL OR phone_hash IS NOT NULL))::bigint AS eligible,
             (SELECT count(*) FROM customers WHERE organization_id = ${org} AND suppressed)::bigint AS suppressed,
             (SELECT count(*) FROM customers WHERE organization_id = ${org} AND consent_status = 'GRANTED')::bigint AS consent_granted,
             (SELECT count(*) FROM customers WHERE organization_id = ${org} AND consent_status = 'DENIED')::bigint AS consent_denied,
             (SELECT count(*) FROM customers WHERE organization_id = ${org} AND consent_status IN ('UNKNOWN','EXPIRED'))::bigint AS consent_unknown,
             (SELECT count(DISTINCT customer_id) FROM audience_members WHERE organization_id = ${org} AND status = 'ACTIVE')::bigint AS in_audiences`.execute(this.db)).rows[0]!;
    const [lifecycle, consent, countries, flags] = await Promise.all([
      sql<{ lifecycle_state: string; n: number }>`SELECT lifecycle_state, count(*)::bigint AS n FROM customers WHERE organization_id = ${org} AND NOT deleted GROUP BY 1 ORDER BY 2 DESC`.execute(this.db),
      sql<{ consent_status: string; n: number }>`SELECT consent_status, count(*)::bigint AS n FROM customers WHERE organization_id = ${org} AND NOT deleted GROUP BY 1`.execute(this.db),
      sql<{ country: string | null; n: number }>`SELECT country, count(*)::bigint AS n FROM customers WHERE organization_id = ${org} AND NOT deleted GROUP BY 1 ORDER BY 2 DESC LIMIT 10`.execute(this.db),
      sql<{ marketing: number; advertising: number; sharing: number; total: number }>`SELECT count(*) FILTER (WHERE marketing_allowed)::bigint AS marketing, count(*) FILTER (WHERE advertising_personalization_allowed)::bigint AS advertising, count(*) FILTER (WHERE data_sharing_allowed)::bigint AS sharing, count(*)::bigint AS total FROM customers WHERE organization_id = ${org} AND NOT deleted`.execute(this.db),
    ]);
    const stats = {
      customers: { total: Number(r.total), eligible: Number(r.eligible), suppressed: Number(r.suppressed), inAudiences: Number(r.in_audiences), consent: { granted: Number(r.consent_granted), denied: Number(r.consent_denied), unknown: Number(r.consent_unknown) } },
      breakdown: {
        lifecycle: lifecycle.rows.map((x) => ({ lifecycle_state: x.lifecycle_state, n: Number(x.n) })),
        consent: consent.rows.map((x) => ({ consent_status: x.consent_status, n: Number(x.n) })),
        countries: countries.rows.map((x) => ({ country: x.country, n: Number(x.n) })),
        flags: { marketing: Number(flags.rows[0]!.marketing), advertising: Number(flags.rows[0]!.advertising), sharing: Number(flags.rows[0]!.sharing), total: Number(flags.rows[0]!.total) },
      },
    };
    await this.db.insertInto('organization_stats').values({ organization_id: org, stats: JSON.stringify(stats), computed_at: new Date(), duration_ms: Date.now() - started })
      .onConflict((oc) => oc.column('organization_id').doUpdateSet({ stats: JSON.stringify(stats), computed_at: new Date(), duration_ms: Date.now() - started })).execute();
    return stats;
  }

  /** Snapshot (lifecycle/consent/country/flag breakdowns) — refreshed hourly by the worker; computed on demand if missing/stale. */
  async customerBreakdown(org: string, maxSnapshotAgeMs = 3600_000) {
    const snap = await this.db.selectFrom('organization_stats').select(['stats', 'computed_at']).where('organization_id', '=', org).executeTakeFirst();
    const st = snap?.stats as { breakdown?: unknown } | undefined;
    if (!snap || !st?.breakdown || Date.now() - snap.computed_at.getTime() > maxSnapshotAgeMs) return { ...(await this.refreshCustomerStats(org)).breakdown, computedAt: new Date() };
    return { ...(st.breakdown as { lifecycle: Array<{ lifecycle_state: string; n: number }>; consent: Array<{ consent_status: string; n: number }>; countries: Array<{ country: string | null; n: number }>; flags: { marketing: number; advertising: number; sharing: number; total: number } }), computedAt: snap.computed_at };
  }

  /** Organization-wide overview for the dashboard (snapshot + cached counters + small aggregates only). */
  async overview(org: string, opts: { maxSnapshotAgeMs?: number } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await this.db.selectFrom('organization_stats').select(['stats', 'computed_at']).where('organization_id', '=', org).executeTakeFirst();
    const stale = !snap || Date.now() - snap.computed_at.getTime() > (opts.maxSnapshotAgeMs ?? 3600_000);
    const customerStats = (stale ? await this.refreshCustomerStats(org) : (snap!.stats as { customers: never })).customers as { total: number; eligible: number; suppressed: number; inAudiences: number; consent: { granted: number; denied: number; unknown: number } };
    const [aud, dest, jobs, camp] = await Promise.all([
      sql<{ active: number; total: number; members: number; added_today: number; removed_today: number }>`
        SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active, count(*) FILTER (WHERE status <> 'ARCHIVED')::int AS total, coalesce(sum(member_count) FILTER (WHERE status='ACTIVE'),0)::bigint AS members,
               coalesce(sum(added_today),0)::bigint AS added_today, coalesce(sum(removed_today),0)::bigint AS removed_today FROM audiences WHERE organization_id = ${org}`.execute(this.db),
      sql<{ type: string; audiences: number; errors: number; submitted: number; matched: number; last_sync_at: Date | null; connected: number }>`
        SELECT d.type, count(ad.id)::int AS audiences, count(ad.id) FILTER (WHERE ad.status = 'ERROR')::int AS errors, coalesce(sum(ad.submitted_count),0)::bigint AS submitted, coalesce(sum(ad.matched_count),0)::bigint AS matched, max(ad.last_synced_at) AS last_sync_at,
               count(DISTINCT d.id) FILTER (WHERE d.status = 'CONNECTED')::int AS connected
        FROM destinations d LEFT JOIN destination_accounts da ON da.destination_id = d.id LEFT JOIN audience_destinations ad ON ad.destination_account_id = da.id AND ad.status <> 'DELETED'
        WHERE d.organization_id = ${org} GROUP BY d.type`.execute(this.db),
      sql<{ today_added: number; today_removed: number; failed_24h: number; success_24h: number; running: number }>`
        SELECT coalesce(sum(added) FILTER (WHERE created_at >= ${today}::date),0)::bigint AS today_added, coalesce(sum(removed) FILTER (WHERE created_at >= ${today}::date),0)::bigint AS today_removed,
               count(*) FILTER (WHERE status = 'FAILED' AND created_at > now() - interval '24 hours')::int AS failed_24h,
               count(*) FILTER (WHERE status IN ('SUCCESS','SUCCESS_WITH_WARNINGS') AND created_at > now() - interval '24 hours')::int AS success_24h,
               count(*) FILTER (WHERE status IN ('RUNNING','QUEUED'))::int AS running
        FROM sync_jobs WHERE organization_id = ${org} AND mode <> 'DRY_RUN'`.execute(this.db),
      sql<{ spend: number; revenue: number; conversions: number; clicks: number; impressions: number }>`
        SELECT coalesce(sum(m.spend),0) AS spend, coalesce(sum(m.conversion_value),0) AS revenue, coalesce(sum(m.conversions),0)::bigint AS conversions, coalesce(sum(m.clicks),0)::bigint AS clicks, coalesce(sum(m.impressions),0)::bigint AS impressions
        FROM campaigns c JOIN campaign_metrics_daily m ON m.campaign_id = c.id WHERE c.organization_id = ${org} AND m.day > current_date - 30`.execute(this.db),
    ]);
    const c = customerStats, a = aud.rows[0]!, j = jobs.rows[0]!, k = camp.rows[0]!;
    const byType = Object.fromEntries(dest.rows.map((d) => [d.type, { ...d, match_rate: pct(Number(d.matched), Number(d.submitted)) }]));
    const submitted = dest.rows.reduce((s, d) => s + Number(d.submitted), 0), matched = dest.rows.reduce((s, d) => s + Number(d.matched), 0);
    return {
      customers: c, statsComputedAt: stale ? new Date() : snap!.computed_at,
      audiences: { active: a.active, total: a.total, members: Number(a.members), addedToday: Number(a.added_today), removedToday: Number(a.removed_today) },
      destinations: byType,
      sync: { activatedToday: Number(j.today_added), removedToday: Number(j.today_removed), failed24h: j.failed_24h, success24h: j.success_24h, running: j.running, health: j.failed_24h === 0 ? 'HEALTHY' : j.success_24h > j.failed_24h ? 'DEGRADED' : 'UNHEALTHY' },
      reach: { submitted, matched, matchRate: pct(matched, submitted), note: 'Estimated reach = platform-matched users, never the source count' },
      campaigns30d: { spend: Number(k.spend), revenue: Number(k.revenue), conversions: Number(k.conversions), clicks: Number(k.clicks), impressions: Number(k.impressions), roas: Number(k.spend) > 0 ? Number(k.revenue) / Number(k.spend) : null, cvr: pct(Number(k.conversions), Number(k.clicks)) },
    };
  }
}
