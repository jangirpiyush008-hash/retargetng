import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/api/v1/auth/login', '/api/v1/health', '/api/v1/ready', '/api/v1/metrics', '/_next', '/favicon.ico', '/api/v1/events', '/api/v1/customers'];
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const hasCookie = req.cookies.has('aap_session');
  const hasBearer = req.headers.get('authorization')?.toLowerCase().startsWith('bearer ');
  if (pathname.startsWith('/api/')) {
    if (!hasCookie && !hasBearer) return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, { status: 401 });
    return NextResponse.next();
  }
  if (!hasCookie) { const url = req.nextUrl.clone(); url.pathname = '/login'; url.searchParams.set('next', pathname); return NextResponse.redirect(url); }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
