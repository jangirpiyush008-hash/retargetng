import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const GET = api({ permission: 'destinations:read' }, async ({ principal }) => ({ data: await ctx().destinations.list(principal.organizationId), catalog: ctx().destinations.catalog(), mode: ctx().registry.currentMode }));
export const POST = api({ permission: 'destinations:manage' }, async ({ principal, req }) => ctx().destinations.connect(principal, await body(req, ApiSchemas.destinationCreate)));
