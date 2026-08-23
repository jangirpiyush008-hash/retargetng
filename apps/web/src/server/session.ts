import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ctx } from './context';
import type { Principal, Permission, SessionInfo } from '@aap/core';
import { can } from '@aap/core';

export const SESSION_COOKIE = 'aap_session';

export async function getSession(): Promise<SessionInfo | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return ctx().auth.resolveSession(token);
}
/** For pages: redirect to login when unauthenticated. */
export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}
/** For API routes: session cookie OR Bearer API key. Returns null when unauthenticated. */
export async function getPrincipal(req?: Request): Promise<{ principal: Principal; session?: SessionInfo } | null> {
  const authz = req?.headers.get('authorization') ?? (await headers()).get('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    const p = await ctx().auth.resolveApiKey(authz.slice(7).trim());
    return p ? { principal: p } : null;
  }
  const s = await getSession();
  return s ? { principal: s.principal, session: s } : null;
}
export function hasPerm(s: SessionInfo | null, p: Permission): boolean { return !!s && can(s.principal, p); }
