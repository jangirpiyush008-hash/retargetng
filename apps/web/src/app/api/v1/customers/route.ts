import { api, body, q, qInt } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas } from '@aap/core';
export const GET = api({ permission: 'customers:read' }, async ({ principal, url }) => {
  const suppressed = q(url, 'suppressed'); 
  return ctx().customers.search(principal, q(url, 'q'), { cursor: q(url, 'cursor'), limit: qInt(url, 'limit', 25), lifecycle: q(url, 'lifecycle'), consent: q(url, 'consent'), suppressed: suppressed == null ? undefined : suppressed === 'true' });
});
/** Upsert customers — implemented as CUSTOMER_CREATED/UPDATED events so there is exactly one ingestion path. */
export const POST = api({ permission: 'customers:write' }, async ({ principal, req }) => {
  const { customers } = await body(req, ApiSchemas.customersUpsert);
  const now = new Date().toISOString();
  const events = customers.map((c, i) => ({ event_id: `upsert_${Date.now()}_${i}_${c.external_customer_id}`, event_type: 'CUSTOMER_UPDATED', occurred_at: c.created_at ?? now, source: 'api',
    customer: { external_customer_id: c.external_customer_id, email: c.email, phone: c.phone, country: c.country },
    payload: { region: c.region, city: c.city, status: c.status, source: c.source, attributes: c.attributes, created_at: c.created_at, consent: c.consent } }));
  return ctx().ingestor.ingest(principal.organizationId, events, { source: 'api' });
});
