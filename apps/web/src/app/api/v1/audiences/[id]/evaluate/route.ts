import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const POST = api({ permission: 'audiences:write' }, async ({ principal, params, req }) => {
  const { mode } = await body(req, ApiSchemas.audienceEvaluate).catch(() => ({ mode: 'INCREMENTAL' as const }));
  await ctx().audiences.getOrThrow(principal.organizationId, params.id!);
  await ctx().audiences.enqueueEvaluation(principal.organizationId, params.id!, mode);
  return { ok: true, enqueued: mode };
});
