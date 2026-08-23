import { NextResponse } from 'next/server';
import { ctx } from '@/server/context';
import { api, body } from '@/server/api';
import { SESSION_COOKIE } from '@/server/session';
import { ApiSchemas, AuditLogger } from '@aap/core';

export const POST = api({ public: true }, async ({ req, ip, userAgent }) => {
  const { email, password } = await body(req, ApiSchemas.login);
  const { token, session } = await ctx().auth.login(email, password, { ip, userAgent });
  await new AuditLogger(ctx().db).log({ organizationId: session.principal.organizationId, actor: session.principal, action: 'USER_LOGIN', entityType: 'user', entityId: session.userId, ip, userAgent });
  const res = NextResponse.json({ ok: true, user: { name: session.userName, email: session.principal.label }, organizationId: session.principal.organizationId, role: session.principal.role });
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', expires: session.expiresAt });
  return res;
});
