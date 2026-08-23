import { NextResponse } from 'next/server';
import { sql } from 'kysely';
import { resolveDatabaseUrl } from '@aap/db';
import { ctx } from '@/server/context';
export const dynamic = 'force-dynamic';

/** Readiness: database reachable + schema migrated + required configuration present. */
export async function GET() {
  const c = ctx();
  const problems: string[] = [];
  const resolved = resolveDatabaseUrl();
  if (!resolved && !c.embedded) problems.push('No database configured: set DATABASE_URL on this service.');
  if (!/^[^:]+:[0-9a-fA-F]{64}/.test(process.env.PII_ENCRYPTION_KEYS ?? '')) problems.push('PII_ENCRYPTION_KEYS is missing or not "kid:<64 hex chars>"');
  let db = 'unknown', migrations = 'unknown';
  try {
    await sql`select 1`.execute(c.db); db = 'up';
    const r = await sql<{ n: number }>`select count(*)::int as n from schema_migrations`.execute(c.db).catch(() => null);
    migrations = r ? `${r.rows[0]?.n ?? 0} applied` : 'pending';
    if (!r && !c.embedded) problems.push('database schema not migrated');
  } catch (e) {
    db = 'down';
    const msg = (e as Error).message;
    problems.push(/ENOTFOUND|getaddrinfo/.test(msg) && resolved?.privateNetwork
      ? `Private host ${resolved.host} does not resolve. Redeploy, or use the database's public URL.`
      : `database unreachable: ${msg.slice(0, 140)}`);
  }
  const ok = problems.length === 0;
  return NextResponse.json({
    ok, db, migrations,
    database: c.embedded
      ? { mode: 'embedded', engine: 'PGlite (in-process PostgreSQL)', dataDir: c.dataDir, note: 'Demo mode — data lives in this container. Set DATABASE_URL for a persistent, multi-process deployment.' }
      : resolved ? { mode: 'external', source: resolved.source, host: resolved.host, privateNetwork: resolved.privateNetwork } : null,
    destinationMode: c.registry.currentMode,
    problems,
  }, { status: ok ? 200 : 503 });
}
