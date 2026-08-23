import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { z } from 'zod';
export const GET = api({ permission: 'destinations:read' }, async ({ principal, params }) => ({ data: (await ctx().destinations.get(principal.organizationId, params.id!)).accounts }));
export const POST = api({ permission: 'destinations:manage' }, async ({ principal, params, req }) => {
  const { accountId, action } = await body(req, z.object({ accountId: z.string().uuid(), action: z.enum(['validate', 'set_default']) }));
  if (action === 'validate') return ctx().destinations.validateAccount(principal, params.id!, accountId);
  await ctx().destinations.setDefaultAccount(principal, params.id!, accountId); return { ok: true };
});
