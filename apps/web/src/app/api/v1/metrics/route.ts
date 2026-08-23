import { metrics } from '@aap/core';
export const dynamic = 'force-dynamic';
export async function GET() { return new Response(metrics.render(), { headers: { 'content-type': 'text/plain; version=0.0.4' } }); }
