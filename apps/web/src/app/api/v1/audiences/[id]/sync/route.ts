import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const POST = api({ permission: 'audiences:activate' }, async ({ principal, params, req }) => ctx().distribution.syncNow(principal, params.id!, await body(req, ApiSchemas.audienceSync).catch(() => ({}))));
