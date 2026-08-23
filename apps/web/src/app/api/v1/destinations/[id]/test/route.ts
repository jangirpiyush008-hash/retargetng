import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const POST = api({ permission: 'destinations:manage' }, async ({ principal, params }) => ctx().destinations.test(principal, params.id!));
