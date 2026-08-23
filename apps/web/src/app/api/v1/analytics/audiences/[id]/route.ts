import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'analytics:read' }, async ({ principal, params, url }) => {
  const days = Number(url.searchParams.get('days') ?? 30); const to = new Date(), from = new Date(to.getTime() - days * 86400_000);
  return ctx().measurement.audienceCampaignMetrics(principal.organizationId, params.id!, from, to);
});
