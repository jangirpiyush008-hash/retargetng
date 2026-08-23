import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'dashboard:read' }, async ({ principal }) => {
  const [overview, audiences, quality, queue] = await Promise.all([ctx().measurement.overview(principal.organizationId), ctx().audiences.summarize(principal.organizationId), ctx().quality.latest(principal.organizationId), ctx().queue.stats()]);
  const recentJobs = await ctx().db.selectFrom('sync_jobs as j').innerJoin('audiences as a', 'a.id', 'j.audience_id').innerJoin('destination_accounts as da', 'da.id', 'j.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id')
    .select(['j.id', 'j.status', 'j.trigger', 'j.mode', 'j.added', 'j.removed', 'j.failed', 'j.started_at', 'j.finished_at', 'a.name as audience_name', 'd.type as destination_type']).where('j.organization_id', '=', principal.organizationId).orderBy('j.created_at', 'desc').limit(8).execute();
  return { overview, audiences: audiences.slice(0, 8), quality: quality ? { score: quality.score, computedAt: quality.computedAt } : null, queue, recentJobs };
});
