import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ctx } from '@/server/context';
import { SESSION_COOKIE } from '@/server/session';

export async function POST() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await ctx().auth.logout(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', expires: new Date(0) });
  return res;
}
