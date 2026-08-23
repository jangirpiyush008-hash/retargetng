import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const DELETE = api({ permission: 'suppression:write' }, async ({ principal, params }) => { await ctx().suppression.revoke(principal, Number(params.id)); return { ok: true }; });
