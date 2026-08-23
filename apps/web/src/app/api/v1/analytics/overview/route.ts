import { api } from '@/server/api';
import { ctx } from '@/server/context';
import { sql } from 'kysely';
export const GET = api({ permission: 'analytics:read' }, async ({ principal }) => {
  const org = principal.organizationId;
  const [overview, perAudience, daily, funnel] = await Promise.all([
    ctx().measurement.overview(org),
    sql<Record<string, unknown>>`
      SELECT a.id, a.name, a.member_count, coalesce(sum(ad.submitted_count),0)::bigint AS submitted, coalesce(sum(ad.matched_count),0)::bigint AS matched,
        coalesce(sum(m.spend),0) AS spend, coalesce(sum(m.conversion_value),0) AS revenue, coalesce(sum(m.conversions),0)::bigint AS conversions, coalesce(sum(m.clicks),0)::bigint AS clicks, coalesce(sum(m.impressions),0)::bigint AS impressions
      FROM audiences a LEFT JOIN audience_destinations ad ON ad.audience_id = a.id AND ad.status <> 'DELETED'
      LEFT JOIN campaign_audiences ca ON ca.audience_id = a.id LEFT JOIN campaign_metrics_daily m ON m.campaign_id = ca.campaign_id AND m.day > current_date - 30
      WHERE a.organization_id = ${org} AND a.status <> 'ARCHIVED' GROUP BY a.id ORDER BY revenue DESC, a.member_count DESC LIMIT 25`.execute(ctx().db),
    sql<{ day: string; spend: number; revenue: number; conversions: number; clicks: number; impressions: number }>`
      SELECT to_char(m.day,'YYYY-MM-DD') AS day, sum(m.spend) AS spend, sum(m.conversion_value) AS revenue, sum(m.conversions)::bigint AS conversions, sum(m.clicks)::bigint AS clicks, sum(m.impressions)::bigint AS impressions
      FROM campaign_metrics_daily m JOIN campaigns c ON c.id = m.campaign_id WHERE c.organization_id = ${org} AND m.day > current_date - 60 GROUP BY 1 ORDER BY 1`.execute(ctx().db),
    sql<{ source: number; eligible: number; submitted: number; matched: number }>`SELECT coalesce(sum(source_count),0)::bigint AS source, coalesce(sum(eligible_count),0)::bigint AS eligible, coalesce(sum(submitted_count),0)::bigint AS submitted, coalesce(sum(matched_count),0)::bigint AS matched FROM audience_destinations WHERE organization_id = ${org} AND status = 'ACTIVE'`.execute(ctx().db),
  ]);
  return { overview, perAudience: perAudience.rows, daily: daily.rows, funnel: funnel.rows[0] };
});
