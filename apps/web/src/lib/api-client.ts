'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }

export async function apiFetch<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path.startsWith('/') ? path : `/api/v1/${path}`, { ...rest, headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body, credentials: 'same-origin' });
  const text = await res.text();
  let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const e = (data as { error?: { message?: string; details?: unknown } })?.error; throw new ApiError(res.status, e?.message ?? `Request failed (${res.status})`, e?.details); }
  return data as T;
}

/** Tiny SWR-like hook: fetch on mount, refetch on interval / manual. */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(!!path);
  const pathRef = useRef(path); pathRef.current = path;
  const load = useCallback(async (silent = false) => {
    if (!pathRef.current) return; if (!silent) setLoading(true);
    try { setData(await apiFetch<T>(pathRef.current)); setError(null); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); if (!opts.refreshMs) return; const t = setInterval(() => void load(true), opts.refreshMs); return () => clearInterval(t); }, [path, load, opts.refreshMs]);
  return { data, error, loading, reload: () => load(true) };
}
