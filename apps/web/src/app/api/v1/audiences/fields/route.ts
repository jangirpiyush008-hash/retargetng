import { api } from '@/server/api';
import { FIELDS, SCALAR_OPERATORS } from '@aap/core';
export const GET = api({ permission: 'audiences:read' }, async () => ({ fields: FIELDS, operators: SCALAR_OPERATORS }));
