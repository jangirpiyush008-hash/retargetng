import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, AuditLogger } from '@aap/core';
export const GET = api({ permission: 'settings:read' }, async ({ principal }) => ({ data: await ctx().db.selectFrom('retention_policies').selectAll().where('organization_id', '=', principal.organizationId).orderBy('data_class').execute() }));
export const PATCH = api({ permission: 'settings:manage' }, async ({ principal, req }) => {
  const { policies } = await body(req, ApiSchemas.retentionUpdate);
  for (const p of policies) await ctx().db.insertInto('retention_policies').values({ organization_id: principal.organizationId, data_class: p.dataClass, retention_days: p.retentionDays }).onConflict((oc) => oc.columns(['organization_id', 'data_class']).doUpdateSet({ retention_days: p.retentionDays, updated_at: new Date() })).execute();
  await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'RETENTION_UPDATED', entityType: 'organization', entityId: principal.organizationId, after: policies });
  return { ok: true };
});
