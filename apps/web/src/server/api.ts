import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { getPrincipal } from './session';
import { ForbiddenError, assertCan, metrics, sanitizeError, type Permission, type Principal } from '@aap/core';

export class HttpError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }

export interface ApiCtx { principal: Principal; req: Request; params: Record<string, string>; url: URL; ip: string | null; userAgent: string | null }
type Handler = (c: ApiCtx) => Promise<unknown> | unknown;

/**
 * Route wrapper: auth (session or API key), permission check, zod body parsing, uniform errors,
 * latency metrics, no stack traces or PII in responses.
 */
export function api(opts: { permission?: Permission; public?: boolean }, handler: Handler) {
  return async (req: Request, route: { params: Promise<Record<string, string>> }) => {
    const started = Date.now(); const url = new URL(req.url);
    try {
      let principal: Principal | null = null;
      if (!opts.public) {
        const a = await getPrincipal(req);
        if (!a) throw new HttpError(401, 'Authentication required');
        principal = a.principal;
        if (opts.permission) assertCan(principal, opts.permission);
      }
      const params = route?.params ? await route.params : {};
      const result = await handler({ principal: principal!, req, params, url, ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null, userAgent: req.headers.get('user-agent') });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof ForbiddenError ? 403 : e instanceof ZodError ? 400 : typeof (e as { status?: number })?.status === 'number' ? (e as { status: number }).status : 500;
      const body = e instanceof ZodError ? { error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }
        : { error: { code: status === 500 ? 'INTERNAL_ERROR' : (e as Error).name ?? 'ERROR', message: status === 500 ? 'Internal error' : sanitizeError((e as Error).message ?? e), details: (e as { details?: unknown })?.details } };
      if (status === 500) console.error('[api]', url.pathname, sanitizeError(e));
      return NextResponse.json(body, { status });
    } finally {
      metrics.apiLatency.observe(Date.now() - started, { path: url.pathname.replace(/[0-9a-f-]{36}|\d+/g, ':id'), method: req.method });
    }
  };
}
export async function body<T extends ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try { json = await req.json(); } catch { throw new HttpError(400, 'Body must be JSON'); }
  return schema.parse(json);
}
export const q = (url: URL, k: string) => url.searchParams.get(k) ?? undefined;
export const qInt = (url: URL, k: string, d?: number) => { const v = url.searchParams.get(k); return v == null ? d : Number(v); };
