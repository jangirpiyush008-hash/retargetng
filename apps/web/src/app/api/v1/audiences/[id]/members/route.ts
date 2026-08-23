import { api, q, qInt } from '@/server/api';
import { ctx } from '@/server/context';
import { maskHash } from '@aap/core';
export const GET = api({ permission: 'customers:read' }, async ({ principal, params, url }) => {
  const limit = Math.min(100, qInt(url, 'limit', 25)!); const cursor = q(url, 'cursor');
  let query = ctx().db.selectFrom('audience_members as m').innerJoin('customers as c', 'c.id', 'm.customer_id')
    .select(['c.id', 'c.external_customer_id', 'c.email_hash', 'c.phone_hash', 'c.country', 'c.lifecycle_state', 'c.order_count', 'c.lifetime_value', 'c.last_order_at', 'c.consent_status', 'c.suppressed', 'm.entered_at', 'm.is_primary'])
    .where('m.audience_id', '=', params.id!).where('m.status', '=', 'ACTIVE').where('c.organization_id', '=', principal.organizationId).orderBy('m.customer_id').limit(limit + 1);
  if (cursor) query = query.where('m.customer_id', '>', Number(cursor));
  const rows = await query.execute();
  const page = rows.slice(0, limit).map((r) => ({ ...r, email_hash: maskHash(r.email_hash), phone_hash: maskHash(r.phone_hash) }));
  return { data: page, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
});
