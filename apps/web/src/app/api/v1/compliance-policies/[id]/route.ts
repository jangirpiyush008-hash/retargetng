import { api, body, HttpError } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, AuditLogger } from '@aap/core';
export const PATCH = api({ permission: 'consent:manage' }, async ({ principal, params, req }) => {
  const b = await body(req, ApiSchemas.compliancePolicyUpsert);
  const before = await ctx().db.selectFrom('compliance_policies').selectAll().where('id', '=', params.id!).where('organization_id', '=', principal.organizationId).executeTakeFirst();
  if (!before) throw new HttpError(404, 'Policy not found');
  await ctx().db.updateTable('compliance_policies').set({ name: b.name, destination_type: b.destinationType ?? null, is_default: b.isDefault ?? before.is_default, rules: JSON.stringify(b.rules), updated_at: new Date() }).where('id', '=', params.id!).execute();
  await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'COMPLIANCE_POLICY_UPDATED', entityType: 'compliance_policy', entityId: params.id!, before: { name: before.name, rules: before.rules }, after: b });
  return { ok: true };
});
