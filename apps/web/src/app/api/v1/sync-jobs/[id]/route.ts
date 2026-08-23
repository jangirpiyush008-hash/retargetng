import { api, HttpError } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'sync:read' }, async ({ principal, params }) => {
  const job = await ctx().db.selectFrom('sync_jobs as j').innerJoin('audiences as a', 'a.id', 'j.audience_id').innerJoin('destination_accounts as da', 'da.id', 'j.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id')
    .selectAll('j').select(['a.name as audience_name', 'a.slug as audience_slug', 'd.type as destination_type', 'd.name as destination_name', 'da.name as account_name', 'da.external_account_id']).where('j.id', '=', params.id!).where('j.organization_id', '=', principal.organizationId).executeTakeFirst();
  if (!job) throw new HttpError(404, 'Sync job not found');
  const batches = await ctx().db.selectFrom('sync_job_batches').select(['seq', 'operation', 'member_count', 'status', 'attempts', 'external_ref', 'response_summary', 'error_code', 'error_message', 'started_at', 'finished_at']).where('sync_job_id', '=', job.id).orderBy('seq').limit(500).execute();
  return { job, batches };
});
