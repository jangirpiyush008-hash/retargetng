import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, AuditLogger, hashPassword } from '@aap/core';
export const GET = api({ permission: 'settings:read' }, async ({ principal }) => ({ data: await ctx().db.selectFrom('organization_members as m').innerJoin('users as u', 'u.id', 'm.user_id').select(['u.id', 'u.email', 'u.name', 'm.role', 'u.last_login_at', 'm.created_at']).where('m.organization_id', '=', principal.organizationId).orderBy('u.email').execute() }));
export const POST = api({ permission: 'members:manage' }, async ({ principal, req }) => {
  const b = await body(req, ApiSchemas.memberInvite);
  const user = await ctx().db.insertInto('users').values({ email: b.email.toLowerCase(), name: b.name, password_hash: await hashPassword(b.password) }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst()
    ?? (await ctx().db.selectFrom('users').select('id').where('email', '=', b.email.toLowerCase()).executeTakeFirstOrThrow());
  await ctx().db.insertInto('organization_members').values({ organization_id: principal.organizationId, user_id: user.id, role: b.role }).onConflict((oc) => oc.columns(['organization_id', 'user_id']).doUpdateSet({ role: b.role })).execute();
  await new AuditLogger(ctx().db).log({ organizationId: principal.organizationId, actor: principal, action: 'MEMBER_ADDED', entityType: 'user', entityId: user.id, after: { email: b.email, role: b.role } });
  return { id: user.id };
});
