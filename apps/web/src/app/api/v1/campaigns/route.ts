import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, AuditLogger } from '@aap/core';
import { sql } from 'kysely';
export const GET = api({ permission: 'campaigns:read' }, async ({ principal }) => {
  const rows = await sql<Record<string, unknown>>`
    SELECT c.id, c.name, c.objective, c.status, c.external_campaign_id, c.start_date, c.end_date, d.type AS destination_type, da.name AS account_name,
      coalesce(sum(m.impressions),0)::bigint AS impressions, coalesce(sum(m.clicks),0)::bigint AS clicks, coalesce(sum(m.spend),0) AS spend, coalesce(sum(m.conversions),0)::bigint AS conversions, coalesce(sum(m.conversion_value),0) AS revenue,
      array_agg(DISTINCT a.name) FILTER (WHERE a.id IS NOT NULL) AS audiences
    FROM campaigns c LEFT JOIN destination_accounts da ON da.id = c.destination_account_id LEFT JOIN destinations d ON d.id = da.destination_id
    LEFT JOIN campaign_metrics_daily m ON m.campaign_id = c.id AND m.day > current_date - 30
    LEFT JOIN campaign_audiences ca ON ca.campaign_id = c.id LEFT JOIN audiences a ON a.id = ca.audience_id
    WHERE c.organization_id = ${principal.organizationId} GROUP BY c.id, d.type, da.name ORDER BY c.created_at DESC`.execute(ctx().db);
  return { data: rows.rows.map((r: Record<string, unknown>) => ({ ...r, roas: Number(r.spend) > 0 ? Number(r.revenue) / Number(r.spend) : null, cpa: Number(r.conversions) > 0 ? Number(r.spend) / Number(r.conversions) : null, ctr: Number(r.impressions) > 0 ? (Number(r.clicks) / Number(r.impressions)) * 100 : null })) };
});
export const POST = api({ permission: 'campaigns:write' }, async ({ principal, req }) => {
  const b = await body(req, ApiSchemas.campaignCreate);
  const id = await ctx().db.transaction().execute(async (trx) => {
    const c = await trx.insertInto('campaigns').values({ organization_id: principal.organizationId, name: b.name, destination_account_id: b.destinationAccountId ?? null, external_campaign_id: b.externalCampaignId ?? null, objective: b.objective ?? null, start_date: b.startDate ?? null, end_date: b.endDate ?? null }).returning('id').executeTakeFirstOrThrow();
    if (b.audienceIds.length) await trx.insertInto('campaign_audiences').values(b.audienceIds.map((a) => ({ campaign_id: c.id, audience_id: a }))).execute();
    return c.id;
  });
  await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'CAMPAIGN_CREATED', entityType: 'campaign', entityId: id, after: b });
  return { id };
});
