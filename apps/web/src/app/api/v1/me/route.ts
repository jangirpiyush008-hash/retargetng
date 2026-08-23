import { cookies } from 'next/headers';
import { api, body, HttpError } from '@/server/api';
import { ctx } from '@/server/context';
import { getSession, SESSION_COOKIE } from '@/server/session';
import { z } from 'zod';

export const GET = api({}, async () => {
  const s = await getSession();
  if (!s) throw new HttpError(401, 'No session (API keys use /api/v1 endpoints directly)');
  return { user: { id: s.userId, name: s.userName, email: s.principal.label }, organizationId: s.principal.organizationId, role: s.principal.role, permissions: s.permissions, organizations: s.organizations, destinationMode: ctx().registry.currentMode };
});
export const PATCH = api({}, async ({ req }) => {
  const { organizationId } = await body(req, z.object({ organizationId: z.string().uuid() }));
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await ctx().auth.switchOrganization(token!, organizationId);
  return { ok: true };
});
