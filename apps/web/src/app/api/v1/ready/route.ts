import { NextResponse } from 'next/server';
import { sql } from 'kysely';
import { ctx } from '@/server/context';
export const dynamic = 'force-dynamic';
/** Readiness: database reachable + schema migrated + required configuration present. */
export async function GET() {
  const problems: string[] = [];
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is not set');
  if (!/^[^:]+:[0-9a-fA-F]{64}/.test(process.env.PII_ENCRYPTION_KEYS ?? '')) problems.push('PII_ENCRYPTION_KEYS is missing or not "kid:<64 hex chars>"');
  let db = 'unknown', migrations = 'unknown';
  if (process.env.DATABASE_URL) {
    try {
      await sql`select 1`.execute(ctx().db); db = 'up';
      const r = await sql<{ n: number }>`select count(*)::int as n from schema_migrations`.execute(ctx().db).catch(() => null);
      migrations = r ? `${r.rows[0]?.n ?? 0} applied` : 'schema_migrations missing — run migrations';
      if (!r) problems.push('database schema not migrated');
    } catch (e) { db = 'down'; problems.push(`database unreachable: ${(e as Error).message.slice(0, 120)}`); }
  }
  const ok = problems.length === 0;
  return NextResponse.json({ ok, db, migrations, problems }, { status: ok ? 200 : 503 });
}
