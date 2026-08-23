import { api, q } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'audiences:read' }, async ({ principal, url }) => {
  const s = (q(url, 'q') ?? '').trim();
  let query = ctx().db.selectFrom('categories').select(['id', 'external_category_id', 'name', 'path']).where('organization_id', '=', principal.organizationId).orderBy('name').limit(100);
  if (s) query = query.where('name', 'ilike', `%${s}%`);
  return { data: await query.execute() };
});
