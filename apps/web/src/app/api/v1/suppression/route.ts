import { api, body, q, qInt } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const GET = api({ permission: 'suppression:read' }, async ({ principal, url }) => ({ ...(await ctx().suppression.list(principal.organizationId, { cursor: q(url, 'cursor'), limit: qInt(url, 'limit', 50), reason: q(url, 'reason') })), stats: await ctx().suppression.stats(principal.organizationId) }));
export const POST = api({ permission: 'suppression:write' }, async ({ principal, req }) => {
  const b = await body(req, ApiSchemas.suppressionCreate);
  const r = await ctx().suppression.add(principal, { ...b, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null });
  // push removals to destinations immediately
  await ctx().distribution.sweepSuppressed(principal.organizationId, new Date(Date.now() - 60_000));
  return r;
});
