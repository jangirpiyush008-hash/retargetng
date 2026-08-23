import { api, q } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'audiences:read' }, async ({ principal, url }) => {
  const s = (q(url, 'q') ?? '').trim(); const ids = q(url, 'ids');
  let query = ctx().db.selectFrom('products as p').leftJoin('categories as c', 'c.id', 'p.category_id').select(['p.id', 'p.external_product_id', 'p.name', 'p.sku', 'p.brand', 'p.price', 'c.name as category']).where('p.organization_id', '=', principal.organizationId).orderBy('p.name').limit(50);
  if (ids) query = query.where('p.id', 'in', ids.split(',').map(Number));
  else if (s) query = query.where((eb) => eb.or([eb('p.name', 'ilike', `%${s}%`), eb('p.external_product_id', 'ilike', `%${s}%`), eb('p.sku', 'ilike', `%${s}%`)]));
  return { data: await query.execute() };
});
