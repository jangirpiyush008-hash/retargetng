import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const GET = api({ permission: 'audiences:read' }, async ({ principal }) => ({ data: await ctx().audiences.summarize(principal.organizationId) }));
export const POST = api({ permission: 'audiences:write' }, async ({ principal, req }) => ctx().audiences.create(principal, await body(req, ApiSchemas.audienceCreate)));
