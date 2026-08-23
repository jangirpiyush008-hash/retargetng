// End-to-end API smoke test against a running web app (needs seeded demo org).
//   BASE_URL=http://localhost:3000 node scripts/smoke.mjs
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let cookie = '';
const api = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  const setCookie = res.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const step = (name, v) => console.log(`✓ ${name}`, typeof v === 'string' ? v : JSON.stringify(v).slice(0, 160));
try {
  step('login', await api('/api/v1/auth/login', { method: 'POST', body: { email: 'admin@demo.aap', password: 'Admin12345!' } }));
  const me = await api('/api/v1/me'); step('me', `${me.user.email} role=${me.role} mode=${me.destinationMode}`);
  const dash = await api('/api/v1/dashboard'); step('dashboard', `customers=${dash.overview.customers.total} eligible=${dash.overview.customers.eligible} audiences=${dash.overview.audiences.active}`);
  const dests = await api('/api/v1/destinations'); step('destinations', dests.data.map((d) => `${d.type}:${d.status}`).join(','));
  const accounts = [];
  for (const d of dests.data.filter((x) => x.status === 'CONNECTED')) { const det = await api(`/api/v1/destinations/${d.id}`); accounts.push(...det.accounts.map((a) => a.id)); }
  const preview = await api('/api/v1/audiences/preview', { method: 'POST', body: { definition: { type: 'group', operator: 'AND', children: [{ type: 'condition', field: 'lifetime_value', operator: 'gte', value: 10000 }, { type: 'condition', field: 'order_count', operator: 'gte', value: 3 }, { type: 'condition', field: 'last_order_at', operator: 'more_than_ago', value: { value: 180, unit: 'days' } }] } } });
  step('preview', `total=${preview.total} eligible=${preview.eligible} activation=${preview.estimatedActivation} estimated=${preview.estimated}`);
  const created = await api('/api/v1/audiences', { method: 'POST', body: { name: `Smoke HV Lapsed ${Date.now()}`, definition: { type: 'group', operator: 'AND', children: [{ type: 'condition', field: 'lifetime_value', operator: 'gte', value: 10000 }, { type: 'condition', field: 'order_count', operator: 'gte', value: 3 }, { type: 'condition', field: 'last_order_at', operator: 'more_than_ago', value: { value: 180, unit: 'days' } }] }, status: 'ACTIVE', evaluationSchedule: 'DAILY', priority: 45 } });
  step('audience created', created.id);
  const detail = await api(`/api/v1/audiences/${created.id}`); step('audience detail', `${detail.audience.name} v${detail.rule.version}: ${detail.rule.description}`);
  if (accounts.length) {
    const dry = await api(`/api/v1/audiences/${created.id}/activate`, { method: 'POST', body: { destinationAccountIds: accounts.slice(0, 1), dryRun: true } });
    step('dry run', `payload=${dry.reports[0].estimatedPayload.records} batches=${dry.reports[0].estimatedPayload.batches} excluded=${dry.reports[0].funnel.excludedByAudience}`);
    const act = await api(`/api/v1/audiences/${created.id}/activate`, { method: 'POST', body: { destinationAccountIds: accounts.slice(0, 1) } });
    step('activate', act.audienceDestinationIds);
    const sync = await api(`/api/v1/audiences/${created.id}/sync`, { method: 'POST', body: {} }); step('sync enqueued', sync);
  }
  const jobs = await api('/api/v1/sync-jobs?limit=5'); step('sync jobs', `${jobs.data.length} recent; queue=${JSON.stringify(jobs.queue)}`);
  const cust = await api('/api/v1/customers?limit=1'); step('customers', `first=${cust.data[0]?.external_customer_id} hash=${cust.data[0]?.email_hash}`);
  if (cust.data[0]) { const c = await api(`/api/v1/customers/${cust.data[0].id}`); step('customer detail', `eligible=${c.eligibility.eligible} memberships=${c.memberships.length} pii_visible=${c.customer.pii_visible}`); }
  const ev = await api('/api/v1/events', { method: 'POST', body: [{ event_id: `smoke_${Date.now()}`, event_type: 'ADD_TO_CART', occurred_at: new Date().toISOString(), customer: { external_customer_id: 'cust_1' }, payload: { product: { external_product_id: 'sku_0001' }, quantity: 1 } }] });
  step('event ingest', ev);
  const an = await api('/api/v1/analytics/overview'); step('analytics', `funnel=${JSON.stringify(an.funnel)}`);
  step('audit', (await api('/api/v1/audit-logs?limit=3')).data.map((a) => a.action).join(','));
  await api(`/api/v1/audiences/${created.id}`, { method: 'DELETE' }); step('archived smoke audience', created.id);
  console.log('\nSMOKE OK');
} catch (e) { console.error('SMOKE FAILED:', e.message); process.exit(1); }
