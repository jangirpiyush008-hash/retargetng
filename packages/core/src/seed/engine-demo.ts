/* Narrated end-to-end trace of the engine (same classes the worker runs). `pnpm --filter @aap/core exec tsx src/seed/engine-demo.ts` */
import { loadEnv, createDbWithPool } from '@aap/db';
loadEnv();
import { sql } from 'kysely';
import { EventIngestor, CustomerEventProcessor, MembershipEngine, DistributionEngine, PgJobQueue, DestinationRegistry, MemorySecretStore, MockDestinationAdapter, compileRule, parseRuleDefinition, describeRule, maskHash, type Principal } from '../index.js';

const { db, pool } = createDbWithPool({ max: 4, applicationName: 'aap-demo' });
const org = (await db.selectFrom('organizations').select('id').where('slug', '=', 'demo').executeTakeFirstOrThrow()).id;
const queue = new PgJobQueue(db); const ingestor = new EventIngestor(db, queue); const processor = new CustomerEventProcessor(db);
const engine = new MembershipEngine(db); const registry = new DestinationRegistry('mock'); const secrets = new MemorySecretStore();
const dist = new DistributionEngine({ db, queue, secrets, registry });
const principal: Principal = { type: 'SYSTEM', id: null, label: 'engine-demo', organizationId: org, role: 'SUPER_ADMIN' };
const ext = `demo_engine_${Date.now()}`; const email = `Priya.Demo+${Date.now()}@Gmail.com`; const phone = `+91 98${String(Date.now()).slice(-8)}`; // unique per run — identical phone would resolve to the same first-party identity
const h = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const kv = (o: Record<string, unknown>) => console.log('   ' + Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  '));
const cust = async () => db.selectFrom('customers').selectAll().where('organization_id', '=', org).where('external_customer_id', '=', ext).executeTakeFirstOrThrow();
const processPending = async () => queue.drain(async (job) => { if (job.name === 'process-events') await processor.processEventIds(org, (job.payload as { events: Array<{ id: number; occurredAt: string }> }).events); }, ['events.process']);
const aud = async (slug: string) => db.selectFrom('audiences').selectAll().where('organization_id', '=', org).where('slug', '=', slug).executeTakeFirstOrThrow();
const isMember = async (audienceId: string, customerId: number) => !!(await db.selectFrom('audience_members').select('status').where('audience_id', '=', audienceId).where('customer_id', '=', customerId).where('status', '=', 'ACTIVE').executeTakeFirst());
const now = new Date(); const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString();

h('STAGE 1 — INGEST: raw events arrive at POST /api/v1/events (customer created + consent + add-to-cart 2 days ago)');
const r1 = await ingestor.ingest(org, [
  { event_id: `${ext}-created`, event_type: 'CUSTOMER_CREATED', occurred_at: daysAgo(30), customer: { external_customer_id: ext, email, phone, country: 'IN' }, payload: { source: 'web', consent: { marketing: true, advertising_personalization: true, data_sharing: true } } },
  { event_id: `${ext}-view`, event_type: 'PRODUCT_VIEWED', occurred_at: daysAgo(2.1), customer: { external_customer_id: ext }, payload: { product: { external_product_id: 'sku_0006' } } },
  { event_id: `${ext}-cart`, event_type: 'ADD_TO_CART', occurred_at: daysAgo(2), customer: { external_customer_id: ext }, payload: { cart_id: 'cart-A', product: { external_product_id: 'sku_0006' }, quantity: 1, value: 4999 } },
  { event_id: `${ext}-cart`, event_type: 'ADD_TO_CART', occurred_at: daysAgo(2), customer: { external_customer_id: ext }, payload: { cart_id: 'cart-A', product: { external_product_id: 'sku_0006' }, quantity: 1, value: 4999 } }, // duplicate replay
]);
kv({ accepted: r1.accepted, duplicates_rejected: r1.duplicates, rejected: r1.rejected.length });
const stored = await db.selectFrom('customer_events').select(['event_type', 'payload']).where('organization_id', '=', org).where('external_customer_id', '=', ext).orderBy('occurred_at').execute();
console.log('   stored payload for CUSTOMER_CREATED (no raw email/phone, only hashes + ciphertext):');
console.log('   ' + JSON.stringify(stored[0]!.payload).replace(/"email_enc":"[^"]+"/, '"email_enc":"<aes-gcm…>"').replace(/"phone_enc":"[^"]+"/, '"phone_enc":"<aes-gcm…>"').slice(0, 330) + '…');

h('STAGE 2 — PROCESS: worker job events.process → identity resolution, hashing, consent, aggregates, lifecycle');
await processPending();
let c = await cust();
kv({ customer_id: c.id, email_hash: maskHash(c.email_hash), phone_hash: maskHash(c.phone_hash), email_valid: c.email_valid, phone_valid: c.phone_valid, country: c.country });
kv({ consent_status: c.consent_status, advertising: c.advertising_personalization_allowed, data_sharing: c.data_sharing_allowed, marketing: c.marketing_allowed });
kv({ has_open_cart: c.has_open_cart, last_cart_at: c.last_cart_at?.toISOString(), cart_event_count: c.cart_event_count, order_count: c.order_count, lifecycle_state: c.lifecycle_state });
const ids = await db.selectFrom('customer_identifiers').select(['kind', 'hash_profile', 'hash']).where('customer_id', '=', c.id).orderBy('hash_profile').execute();
console.log('   activation identifiers (what destinations receive — never the raw value):'); for (const i of ids) console.log(`     ${i.kind.padEnd(5)} ${i.hash_profile.padEnd(20)} ${i.hash.toString('hex').slice(0, 16)}…`);

h('STAGE 3 — SEGMENT: the audience rule compiles to SQL; incremental evaluation looks only at changed customers + time-boundary crossers');
const cart13 = await aud('CART_ABANDONERS_1_3D');
const rule = await db.selectFrom('audience_rules').select('definition').where('audience_id', '=', cart13.id).where('version', '=', cart13.current_rule_version).executeTakeFirstOrThrow();
const def = parseRuleDefinition(rule.definition);
console.log('   rule   : ' + describeRule(def));
console.log('   sql    : ' + compileRule(def, { now, organizationId: org }).predicate.compile(db).sql);
const e1 = await engine.evaluate(cart13.id, { watermarkLagSeconds: 0 }); // demo runs faster than the 30s in-flight safety lag
kv({ mode: e1.mode, candidates_evaluated: e1.candidates, entered: e1.entered, exited: e1.exited, member_count: e1.memberCount, ms: e1.durationMs, out_of_1M_customers: true });
console.log(`   → our customer in CART_ABANDONERS_1_3D: ${await isMember(cart13.id, c.id)}`);

h('STAGE 4 — DISTRIBUTE: eligibility funnel → delta vs destination state → hashed batch to Meta (mock adapter, in-memory)');
const ad = await db.selectFrom('audience_destinations as ad').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id').select(['ad.id', 'd.type', 'ad.external_audience_id']).where('ad.audience_id', '=', cart13.id).where('d.type', '=', 'META').executeTakeFirstOrThrow();
const meta = registry.get('META') as MockDestinationAdapter;
const s1 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'MANUAL' });
kv({ job: s1.jobId.slice(0, 8), status: s1.status, source_members: s1.sourceCount, eligible: s1.eligibleCount, added: s1.added, removed: s1.removed, batches: s1.batchesTotal });
kv({ rejected_by_funnel: s1.funnel });
const last = meta.calls.filter((x) => x.op === 'addMembers').pop();
console.log(`   adapter call: ${last?.op} audience=${last?.audience} members=${last?.count} seq=${last?.seq}  (Meta schema ["EMAIL","PHONE"], SHA-256 hex rows)`);
const ourState = await db.selectFrom('audience_destination_members').select('state').where('audience_destination_id', '=', ad.id).where('customer_id', '=', c.id).executeTakeFirst();
console.log(`   → destination state for our customer: ${ourState?.state}`);

h('STAGE 5 — SHE BUYS: purchase event → cart converts → leaves cart audience, enters recent purchasers → next sync REMOVES her from the Meta list');
await ingestor.ingest(org, [{ event_id: `${ext}-order`, event_type: 'PURCHASE_COMPLETED', occurred_at: new Date().toISOString(), customer: { external_customer_id: ext }, payload: { order: { external_order_id: `${ext}-o1`, total: 4999, cart_id: 'cart-A', items: [{ product: { external_product_id: 'sku_0006' }, quantity: 1, unit_price: 4999 }] } } }]);
await processPending(); c = await cust();
kv({ has_open_cart: c.has_open_cart, order_count: c.order_count, total_revenue: Number(c.total_revenue), lifecycle_state: c.lifecycle_state });
const e2 = await engine.evaluate(cart13.id, { watermarkLagSeconds: 0 }); const recent = await aud('RECENT_PURCHASERS_7D'); const e3 = await engine.evaluate(recent.id, { watermarkLagSeconds: 0 });
kv({ cart_audience: { candidates: e2.candidates, entered: e2.entered, exited: e2.exited }, recent_purchasers: { candidates: e3.candidates, entered: e3.entered, exited: e3.exited } });
console.log(`   → in CART_ABANDONERS_1_3D: ${await isMember(cart13.id, c.id)}   in RECENT_PURCHASERS_7D: ${await isMember(recent.id, c.id)}`);
const s2 = await dist.runSync({ organizationId: org, audienceDestinationId: ad.id, trigger: 'SCHEDULED' });
kv({ job: s2.jobId.slice(0, 8), status: s2.status, added: s2.added, removed: s2.removed, batches: s2.batchesTotal });
console.log(`   → cart-audience destination state for our customer: ${(await db.selectFrom('audience_destination_members').select('state').where('audience_destination_id', '=', ad.id).where('customer_id', '=', c.id).executeTakeFirst())?.state}`);
const adRecent = await db.selectFrom('audience_destinations as ad').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id').select(['ad.id']).where('ad.audience_id', '=', recent.id).where('d.type', '=', 'META').executeTakeFirstOrThrow();
const s3 = await dist.runSync({ organizationId: org, audienceDestinationId: adRecent.id, trigger: 'SCHEDULED' });
kv({ recent_purchasers_7d_to_meta: { job: s3.jobId.slice(0, 8), status: s3.status, added: s3.added, removed: s3.removed } });
console.log(`   → recent-purchasers destination state for our customer: ${(await db.selectFrom('audience_destination_members').select('state').where('audience_destination_id', '=', adRecent.id).where('customer_id', '=', c.id).executeTakeFirst())?.state}`);

h('STAGE 6 — SHE OPTS OUT: CONSENT_REVOKED → global suppression → ineligible everywhere; suppression sweep queues removal from every destination she is in');
await ingestor.ingest(org, [{ event_id: `${ext}-optout`, event_type: 'CONSENT_REVOKED', occurred_at: new Date().toISOString(), customer: { external_customer_id: ext }, payload: { purposes: { advertising_personalization: false, data_sharing: false }, source: 'preference_center' } }]);
await processPending(); c = await cust();
kv({ consent_status: c.consent_status, suppressed: c.suppressed, suppression_reason: (await db.selectFrom('suppression_records').select('reason').where('customer_id', '=', c.id).executeTakeFirst())?.reason });
const swept = await dist.sweepSuppressed(org, new Date(Date.now() - 60_000));
console.log(`   suppression sweep enqueued syncs for ${swept} destination audience(s) she is currently synced to`);
const s4 = await dist.runSync({ organizationId: org, audienceDestinationId: adRecent.id, trigger: 'SUPPRESSION' });
kv({ suppression_sync: { job: s4.jobId.slice(0, 8), status: s4.status, added: s4.added, removed: s4.removed } });
console.log(`   → recent-purchasers destination state for our customer: ${(await db.selectFrom('audience_destination_members').select('state').where('audience_destination_id', '=', adRecent.id).where('customer_id', '=', c.id).executeTakeFirst())?.state}`);
const elig = await sql<{ reason: string | null }>`SELECT ${(await import('../consent/policy.js')).compilePolicyReasonExpr((await import('../consent/policy.js')).DEFAULT_POLICY, new Date())} AS reason FROM customers c WHERE c.id = ${c.id}`.execute(db);
console.log(`   compliance policy verdict for her now: ${elig.rows[0]?.reason ?? 'ELIGIBLE'}`);

h('STAGE 7 — AUDIT TRAIL & JOB LOG (who/what/when, never PII)');
for (const j of await db.selectFrom('sync_jobs').select(['id', 'trigger', 'status', 'source_count', 'eligible_count', 'added', 'removed', 'suppressed_count', 'consent_denied_count']).where('id', 'in', [s1.jobId, s2.jobId, s3.jobId, s4.jobId]).orderBy('created_at').execute()) kv(j as never);
for (const a of await db.selectFrom('audit_logs').select(['action', 'entity_type', 'actor_label', 'occurred_at']).where('organization_id', '=', org).orderBy('id', 'desc').limit(4).execute()) kv({ ...a, occurred_at: a.occurred_at.toISOString() });
console.log('\nDone. (Demo customer left in place as ' + ext + ')');
await db.destroy(); void pool; void principal;
