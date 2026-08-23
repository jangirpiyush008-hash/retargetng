import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'customers:read' }, async ({ principal }) => ({ latest: await ctx().quality.latest(principal.organizationId), stats: await ctx().customers.stats(principal.organizationId) }));
export const POST = api({ permission: 'customers:write' }, async ({ principal }) => ctx().quality.compute(principal.organizationId));
