import { api } from '@/server/api';
import { ctx } from '@/server/context';
export const GET = api({ permission: 'destinations:read' }, async () => ({ catalog: ctx().destinations.catalog(), mode: ctx().registry.currentMode }));
