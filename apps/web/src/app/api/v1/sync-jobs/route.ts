import { api, q, qInt } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'sync:read' }, async ({ principal, url }) => {
  const limit = Math.min(100, qInt(url, 'limit', 30)!); const cursor = q(url, 'cursor'); const status = q(url, 'status'); const audienceId = q(url, 'audienceId');
  let query = ctx().db.selectFrom('sync_jobs as j').innerJoin('audiences as a', 'a.id', 'j.audience_id').innerJoin('destination_accounts as da', 'da.id', 'j.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id')
    .select(['j.id', 'j.status', 'j.trigger', 'j.mode', 'j.started_at', 'j.finished_at', 'j.created_at', 'j.records_evaluated', 'j.source_count', 'j.eligible_count', 'j.added', 'j.removed', 'j.skipped', 'j.failed', 'j.batches_total', 'j.batches_done', 'j.error', 'a.id as audience_id', 'a.name as audience_name', 'd.type as destination_type', 'da.name as account_name'])
    .where('j.organization_id', '=', principal.organizationId).orderBy('j.created_at', 'desc').limit(limit + 1);
  if (cursor) query = query.where('j.created_at', '<', new Date(cursor));
  if (status) query = query.where('j.status', '=', status);
  if (audienceId) query = query.where('j.audience_id', '=', audienceId);
  const rows = await query.execute();
  const page = rows.slice(0, limit);
  const counts = await ctx().db.selectFrom('sync_jobs').select(['status']).select((eb) => eb.fn.countAll<number>().as('n')).where('organization_id', '=', principal.organizationId).where('created_at', '>', new Date(Date.now() - 7 * 86400_000)).groupBy('status').execute();
  return { data: page, nextCursor: rows.length > limit ? page[page.length - 1]!.created_at.toISOString() : null, counts7d: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), queue: await ctx().queue.stats() };
});
