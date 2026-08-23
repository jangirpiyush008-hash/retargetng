import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'destinations:read' }, async ({ principal, params }) => ctx().destinations.get(principal.organizationId, params.id!));
export const DELETE = api({ permission: 'destinations:manage' }, async ({ principal, params, url }) => {
  if (url.searchParams.get('hard') === 'true') await ctx().destinations.remove(principal, params.id!); else await ctx().destinations.disconnect(principal, params.id!);
  return { ok: true };
});
