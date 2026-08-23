import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const POST = api({ permission: 'audiences:read' }, async ({ principal, params, url }) => {
  const c = ctx(); const aud = await c.audiences.getOrThrow(principal.organizationId, params.id!);
  const rule = await c.db.selectFrom('audience_rules').select('definition').where('audience_id', '=', aud.id).where('version', '=', aud.current_rule_version).executeTakeFirstOrThrow();
  return c.audiences.preview(principal.organizationId, { audienceId: aud.id, definition: rule.definition as never, destinationType: url.searchParams.get('destinationType') });
});
