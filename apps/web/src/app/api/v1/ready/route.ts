import { NextResponse } from 'next/server';
import { sql } from 'kysely';
import { resolveDatabaseUrl } from '@aap/db';
import { ctx } from '@/server/context';
export const dynamic = 'force-dynamic';
/** Readiness: database reachable + schema migrated + required configuration present. */
export async function GET() {
  const problems: string[] = [];
  const resolved = resolveDatabaseUrl();
  if (!resolved) problems.push('No database configured: set DATABASE_URL on this service (Railway: reference your Postgres service, or paste its DATABASE_URL value literally).');
  if (!/^[^:]+:[0-9a-fA-F]{64}/.test(process.env.PII_ENCRYPTION_KEYS ?? '')) problems.push('PII_ENCRYPTION_KEYS is missing or not "kid:<64 hex chars>"');
  let db = 'unknown', migrations = 'unknown';
  if (resolved) {
    try {
      await sql`select 1`.execute(ctx().db); db = 'up';
      const r = await sql<{ n: number }>`select count(*)::int as n from schema_migrations`.execute(ctx().db).catch(() => null);
      migrations = r ? `${r.rows[0]?.n ?? 0} applied` : 'schema_migrations missing — run migrations';
      if (!r) problems.push('database schema not migrated');
    } catch (e) {
      db = 'down';
      const msg = (e as Error).message;
      problems.push(/ENOTFOUND|getaddrinfo/.test(msg) && resolved.privateNetwork
        ? `Private host ${resolved.host} does not resolve. Redeploy (private networking needs the database in the same environment), or enable the Postgres TCP proxy and use DATABASE_PUBLIC_URL.`
        : `database unreachable: ${msg.slice(0, 140)}`);
    }
  }
  const ok = problems.length === 0;
  return NextResponse.json({ ok, db, migrations, database: resolved ? { source: resolved.source, host: resolved.host, privateNetwork: resolved.privateNetwork } : null, problems }, { status: ok ? 200 : 503 });
}
