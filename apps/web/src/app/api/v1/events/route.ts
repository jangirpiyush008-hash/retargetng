import { api } from '@/server/api';
import { ctx } from '@/server/context';
import { HttpError } from '@/server/api';
export const POST = api({ permission: 'events:write' }, async ({ principal, req }) => {
  let json: unknown; try { json = await req.json(); } catch { throw new HttpError(400, 'Body must be JSON'); }
  const events = Array.isArray(json) ? json : (json as { events?: unknown[] })?.events ?? json;
  return ctx().ingestor.ingest(principal.organizationId, events, { source: principal.type === 'API_KEY' ? `api_key:${principal.label}` : 'dashboard' });
});
