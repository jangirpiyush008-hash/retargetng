import { api, body, HttpError } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const GET = api({ permission: 'campaigns:read' }, async ({ principal, params }) => {
  const c = await ctx().db.selectFrom('campaigns').select('id').where('id', '=', params.id!).where('organization_id', '=', principal.organizationId).executeTakeFirst();
  if (!c) throw new HttpError(404, 'Campaign not found');
  return { data: await ctx().db.selectFrom('campaign_metrics_daily').selectAll().where('campaign_id', '=', c.id).orderBy('day').limit(365).execute() };
});
/** Ingest platform-reported daily metrics (from a connector or manual upload). */
export const POST = api({ permission: 'campaigns:write' }, async ({ principal, params, req }) => {
  const c = await ctx().db.selectFrom('campaigns').select('id').where('id', '=', params.id!).where('organization_id', '=', principal.organizationId).executeTakeFirst();
  if (!c) throw new HttpError(404, 'Campaign not found');
  const { rows } = await body(req, ApiSchemas.campaignMetrics);
  await ctx().db.insertInto('campaign_metrics_daily').values(rows.map((r) => ({ campaign_id: c.id, day: r.day, impressions: r.impressions, clicks: r.clicks, spend: r.spend, conversions: r.conversions, conversion_value: r.conversionValue, reach: r.reach ?? null, frequency: r.frequency ?? null })))
    .onConflict((oc) => oc.columns(['campaign_id', 'day']).doUpdateSet((eb) => ({ impressions: eb.ref('excluded.impressions'), clicks: eb.ref('excluded.clicks'), spend: eb.ref('excluded.spend'), conversions: eb.ref('excluded.conversions'), conversion_value: eb.ref('excluded.conversion_value'), reach: eb.ref('excluded.reach'), frequency: eb.ref('excluded.frequency') }))).execute();
  return { upserted: rows.length };
});
