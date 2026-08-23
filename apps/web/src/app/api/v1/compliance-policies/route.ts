import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, AuditLogger } from '@aap/core';
export const GET = api({ permission: 'consent:read' }, async ({ principal }) => ({ data: await ctx().db.selectFrom('compliance_policies').selectAll().where('organization_id', '=', principal.organizationId).orderBy('destination_type').execute() }));
export const POST = api({ permission: 'consent:manage' }, async ({ principal, req }) => {
  const b = await body(req, ApiSchemas.compliancePolicyUpsert);
  const r = await ctx().db.insertInto('compliance_policies').values({ organization_id: principal.organizationId, name: b.name, destination_type: b.destinationType ?? null, is_default: b.isDefault ?? false, rules: JSON.stringify(b.rules), created_by: principal.id }).returning('id').executeTakeFirstOrThrow();
  await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'COMPLIANCE_POLICY_CREATED', entityType: 'compliance_policy', entityId: r.id, after: b });
  return { id: r.id };
});
