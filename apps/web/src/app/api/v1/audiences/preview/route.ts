import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const POST = api({ permission: 'audiences:read' }, async ({ principal, req }) => ctx().audiences.preview(principal.organizationId, await body(req, ApiSchemas.audiencePreview)));
