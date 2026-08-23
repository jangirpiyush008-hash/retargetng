import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'customers:read' }, async ({ principal, params }) => ctx().customers.detail(principal, Number(params.id)));
