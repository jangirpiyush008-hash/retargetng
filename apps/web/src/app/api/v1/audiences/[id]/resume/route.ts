import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const POST = api({ permission: 'audiences:activate' }, async ({ principal, params, url }) => { await ctx().distribution.resume(principal, params.id!, url.searchParams.get('audienceDestinationId') ?? undefined); return { ok: true }; });
