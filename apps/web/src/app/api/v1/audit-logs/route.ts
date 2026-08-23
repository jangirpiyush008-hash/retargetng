import { api, q, qInt } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'audit:read' }, async ({ principal, url }) => {
  const limit = Math.min(200, qInt(url, 'limit', 50)!); const cursor = q(url, 'cursor'); const action = q(url, 'action'); const entity = q(url, 'entityType');
  let query = ctx().db.selectFrom('audit_logs').selectAll().where('organization_id', '=', principal.organizationId).orderBy('id', 'desc').limit(limit + 1);
  if (cursor) query = query.where('id', '<', Number(cursor));
  if (action) query = query.where('action', '=', action);
  if (entity) query = query.where('entity_type', '=', entity);
  const rows = await query.execute(); const page = rows.slice(0, limit);
  return { data: page, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
});
