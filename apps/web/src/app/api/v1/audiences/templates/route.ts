import { api } from '@/server/api';
import { TEMPLATES, STANDARD_AUDIENCES } from '@aap/core';
export const GET = api({ permission: 'audiences:read' }, async () => ({ templates: TEMPLATES.map(({ build, ...t }) => { void build; return t; }), standard: STANDARD_AUDIENCES }));
