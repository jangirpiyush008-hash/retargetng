import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'analytics:read' }, async ({ principal, params, url }) => {
  const aud = await ctx().audiences.getOrThrow(principal.organizationId, params.id!);
  const days = Number(url.searchParams.get('days') ?? 30); const to = new Date(), from = new Date(to.getTime() - days * 86400_000);
  if (url.searchParams.get('refresh') === 'true') await ctx().measurement.rollupHoldoutOutcomes(aud.id, from, to);
  const daily = await ctx().db.selectFrom('audience_outcomes_daily').selectAll().where('audience_id', '=', aud.id).where('day', '>=', from).orderBy('day').execute();
  return { audience: { id: aud.id, name: aud.name, holdoutPercent: Number(aud.holdout_percent) }, report: await ctx().measurement.holdoutReport(aud.id, from, to), daily };
});
