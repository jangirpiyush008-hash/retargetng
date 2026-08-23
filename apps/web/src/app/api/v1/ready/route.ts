import { NextResponse } from 'next/server';
import { sql } from 'kysely';
import { ctx } from '@/server/context';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { await sql`select 1`.execute(ctx().db); return NextResponse.json({ ok: true, db: 'up' }); }
  catch (e) { return NextResponse.json({ ok: false, db: 'down' }, { status: 503 }); }
}
