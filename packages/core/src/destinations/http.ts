import { DestinationError, type DestinationErrorKind } from './types.js';
import { metrics } from '../observability/metrics.js';
import { backoffMs, sleep } from '../util/time.js';

export interface HttpJsonOptions {
  fetchImpl?: typeof fetch;
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  /** retries for TRANSIENT / RATE_LIMITED errors */
  retries?: number;
  destination: string;
  operation: string;
  /** map (status, json) → DestinationError or null if the response is a success */
  classify: (status: number, json: unknown, headers: Headers) => DestinationError | null;
}

/** JSON HTTP call with timeouts, retry on transient/rate-limit, metrics, and NO body logging. */
export async function httpJson<T = unknown>(url: string, o: HttpJsonOptions): Promise<{ status: number; json: T; headers: Headers }> {
  const f = o.fetchImpl ?? fetch;
  const retries = o.retries ?? 4;
  let attempt = 0;
  for (;;) {
    attempt++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 60_000);
    const started = Date.now();
    let res: Response | undefined; let err: unknown;
    try {
      res = await f(url, { method: o.method ?? 'GET', headers: o.headers, body: o.body, signal: ctrl.signal });
    } catch (e) { err = e; } finally { clearTimeout(timer); }
    metrics.destinationLatency.observe(Date.now() - started, { destination: o.destination, operation: o.operation });
    if (!res) {
      metrics.destinationRequests.inc({ destination: o.destination, operation: o.operation, status: 'network' });
      const de = new DestinationError(`network error: ${(err as Error)?.name ?? 'unknown'}`, 'TRANSIENT', true);
      if (attempt <= retries) { await sleep(backoffMs(attempt, 500, 30_000)); continue; }
      throw de;
    }
    let json: unknown = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    metrics.destinationRequests.inc({ destination: o.destination, operation: o.operation, status: String(res.status) });
    const classified = o.classify(res.status, json, res.headers);
    if (!classified) return { status: res.status, json: json as T, headers: res.headers };
    if (classified.retryable && attempt <= retries) {
      const wait = classified.opts.retryAfterMs ?? backoffMs(attempt, 1000, 60_000);
      await sleep(wait);
      continue;
    }
    throw classified;
  }
}

export function retryAfterMs(headers: Headers): number | undefined {
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const n = Number(ra);
  if (!Number.isNaN(n)) return n * 1000;
  const d = Date.parse(ra);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export function kindFromHttpStatus(status: number): DestinationErrorKind {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'AUTH_EXPIRED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'TRANSIENT';
  if (status >= 400) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}
