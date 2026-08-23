import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { BulkCreateAudiencesSchema } from '@aap/core';

/** Create many audiences at once (standard library, per product/category, or explicit items). */
export const POST = api({ permission: 'audiences:write' }, async ({ principal, req }) =>
  ctx().audiences.createBulk(principal, await body(req, BulkCreateAudiencesSchema)),
);
