import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const POST = api({ permission: 'audiences:activate' }, async ({ principal, params }) => { await ctx().distribution.retryJob(principal, params.id!); return { ok: true }; });
