import { api } from '@/server/api';
import { ctx } from '@/server/context';
import { AuditLogger } from '@aap/core';
export const DELETE = api({ permission: 'settings:manage' }, async ({ principal, params }) => { await ctx().auth.revokeApiKey(principal, params.id!); await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'API_KEY_REVOKED', entityType: 'api_key', entityId: params.id! }); return { ok: true }; });
