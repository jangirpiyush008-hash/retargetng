import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const DELETE = api({ permission: 'audiences:delete' }, async ({ principal, params }) => { await ctx().distribution.deactivate(principal, params.id!, params.adId!); return { ok: true }; });
