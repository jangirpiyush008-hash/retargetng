import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { z } from 'zod';
export const POST = api({ permission: 'destinations:manage' }, async ({ principal, params, req }) => { const { credential } = await body(req, z.object({ credential: z.string().min(1) })); return ctx().destinations.reconnect(principal, params.id!, credential); });
