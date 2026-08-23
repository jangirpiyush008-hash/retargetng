import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'audiences:read' }, async ({ principal, params }) => {
  await ctx().audiences.getOrThrow(principal.organizationId, params.id!);
  const [stats, runs, jobs] = await Promise.all([
    ctx().db.selectFrom('audience_stats_daily').selectAll().where('audience_id', '=', params.id!).orderBy('day').limit(180).execute(),
    ctx().db.selectFrom('audience_eval_runs').selectAll().where('audience_id', '=', params.id!).orderBy('started_at', 'desc').limit(50).execute(),
    ctx().db.selectFrom('sync_jobs').selectAll().where('audience_id', '=', params.id!).orderBy('created_at', 'desc').limit(50).execute(),
  ]);
  return { stats, runs, jobs };
});
