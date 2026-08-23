import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, AuditLogger } from '@aap/core';
export const GET = api({ permission: 'settings:read' }, async ({ principal }) => ({ data: await ctx().db.selectFrom('api_keys').select(['id', 'name', 'key_prefix', 'scopes', 'created_at', 'last_used_at', 'expires_at', 'revoked_at']).where('organization_id', '=', principal.organizationId).orderBy('created_at', 'desc').execute() }));
export const POST = api({ permission: 'settings:manage' }, async ({ principal, req }) => {
  const b = await body(req, ApiSchemas.apiKeyCreate);
  const r = await ctx().auth.createApiKey(principal, { name: b.name, scopes: b.scopes, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null });
  await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'API_KEY_CREATED', entityType: 'api_key', entityId: r.id, after: { name: b.name, scopes: b.scopes } });
  return r; // full key returned once
});
