import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '@aap/db/test-utils';
import { EventIngestor } from './ingest.js';
import { CustomerEventProcessor } from './processor.js';
import { PgJobQueue } from '../queue/pg-queue.js';
import { createOrg } from '../testing/fixtures.js';
import { sha256 } from '../crypto/hash.js';

let t: TestDb; let org: string; let ingestor: EventIngestor; let processor: CustomerEventProcessor; let queue: PgJobQueue;
const T0 = new Date('2026-08-20T10:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3600_000).toISOString();
let n = 0;
const ev = (event_type: string, customer: Record<string, unknown>, payload: Record<string, unknown> = {}, occurred_at = at(n)) => ({ event_id: `evt_${++n}`, event_type, occurred_at, customer, payload });

async function run(events: unknown[]) {
  const r = await ingestor.ingest(org, events);
  await queue.drain(async (job) => { await processor.processEventIds(org, (job.payload as { events: Array<{ id: number; occurredAt: string }> }).events); });
  return r;
}
const customer = (id: number) => t.db.selectFrom('customers').selectAll().where('organization_id', '=', org).where('id', '=', id).executeTakeFirstOrThrow();
const byExt = (ext: string) => t.db.selectFrom('customers').selectAll().where('organization_id', '=', org).where('external_customer_id', '=', ext).executeTakeFirstOrThrow();

beforeAll(async () => { t = await createTestDb(); queue = new PgJobQueue(t.db); ingestor = new EventIngestor(t.db, queue); processor = new CustomerEventProcessor(t.db); });
beforeEach(async () => { await t.truncateAll(); org = await createOrg(t.db); n = 0; });
afterAll(async () => { await t.close(); });

describe('event ingestion', () => {
  it('stores events without raw PII and is idempotent on event_id', async () => {
    const e = ev('CUSTOMER_CREATED', { external_customer_id: 'c1', email: 'Jane.Doe@Example.com', phone: '9876543210', country: 'IN' }, { consent: { marketing: true, advertising_personalization: true, data_sharing: true } });
    const r1 = await ingestor.ingest(org, [e]);
    const r2 = await ingestor.ingest(org, [e]);
    expect(r1).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(r2).toMatchObject({ accepted: 0, duplicates: 1 });
    const row = await t.db.selectFrom('customer_events').selectAll().where('organization_id', '=', org).executeTakeFirstOrThrow();
    const json = JSON.stringify(row.payload);
    expect(json).not.toContain('jane.doe@example.com');
    expect(json).not.toContain('9876543210');
    expect((row.payload as { customer: { email_hash: string } }).customer.email_hash).toBe(sha256('jane.doe@example.com').toString('hex'));
  });
  it('rejects malformed events with per-item errors', async () => {
    const r = await ingestor.ingest(org, [{ event_id: 'x', event_type: 'PURCHASE_COMPLETED', occurred_at: at(0), customer: { external_customer_id: 'c1' }, payload: { order: { total: 'abc' } } }]);
    expect(r.accepted).toBe(0);
    expect(r.rejected[0]!.errors.join(' ')).toMatch(/payload\.order/);
  });
});

describe('event processor', () => {
  it('creates a customer with hashes, encrypted PII, identifiers and consent', async () => {
    await run([ev('CUSTOMER_CREATED', { external_customer_id: 'c1', email: 'jane@example.com', phone: '+919876543210', country: 'IN' }, { consent: { marketing: true, advertising_personalization: true, data_sharing: true }, attributes: { tier: 'gold' } })]);
    const c = await byExt('c1');
    expect(c.email_hash!.equals(sha256('jane@example.com'))).toBe(true);
    expect(c.email_encrypted).toBeTruthy();
    expect(c.consent_status).toBe('GRANTED');
    expect(c.advertising_personalization_allowed).toBe(true);
    const idents = await t.db.selectFrom('customer_identifiers').select('hash_profile').where('customer_id', '=', c.id).execute();
    expect(idents.map((i) => i.hash_profile).sort()).toEqual(['EMAIL_SHA256', 'EMAIL_SHA256_GOOGLE', 'PHONE_DIGITS_SHA256', 'PHONE_E164_SHA256']);
    expect(c.lifecycle_state).toBe('PROSPECT');
  });

  it('cart → purchase converts the cart; duplicate purchase events are idempotent', async () => {
    await run([
      ev('CUSTOMER_CREATED', { external_customer_id: 'c2', email: 'a@example.com' }),
      ev('ADD_TO_CART', { external_customer_id: 'c2' }, { cart_id: 'cart1', product: { external_product_id: 'shoes', name: 'Shoes', external_category_id: 'footwear' }, quantity: 1, value: 2999 }),
    ]);
    let c = await byExt('c2');
    expect(c.has_open_cart).toBe(true);
    expect(c.lifecycle_state).toBe('CART_ABANDONER');
    const purchase = (eid: string) => ({ ...ev('PURCHASE_COMPLETED', { external_customer_id: 'c2' }, { order: { external_order_id: 'o1', total: 2999, cart_id: 'cart1', items: [{ product: { external_product_id: 'shoes', external_category_id: 'footwear' }, quantity: 1, unit_price: 2999 }] } }, at(5)), event_id: eid });
    await run([purchase('p1'), purchase('p1-dup-different-id')]);
    c = await byExt('c2');
    expect(c.has_open_cart).toBe(false);
    expect(c.order_count).toBe(1);
    expect(Number(c.total_revenue)).toBe(2999);
    expect(c.lifecycle_state).toBe('PURCHASER');
    expect((await t.db.selectFrom('orders').selectAll().where('customer_id', '=', c.id).execute()).length).toBe(1);
    const cpp = await t.db.selectFrom('customer_product_purchases').selectAll().where('customer_id', '=', c.id).execute();
    expect(cpp).toHaveLength(1);
    expect(cpp[0]!.purchase_count).toBe(1);
    const ccp = await t.db.selectFrom('customer_category_purchases').selectAll().where('customer_id', '=', c.id).execute();
    expect(ccp).toHaveLength(1);
    // second distinct order → repeat purchaser, AOV recomputed
    await run([ev('PURCHASE_COMPLETED', { external_customer_id: 'c2' }, { order: { external_order_id: 'o2', total: 1001, items: [] } }, at(30))]);
    c = await byExt('c2');
    expect(c.order_count).toBe(2);
    expect(Number(c.average_order_value)).toBe(2000);
    expect(c.lifecycle_state).toBe('REPEAT_PURCHASER');
    // duplicate ADD_TO_CART event id → ignored
    const dup = ev('ADD_TO_CART', { external_customer_id: 'c2' }, { product: { external_product_id: 'socks' } }, at(40));
    const r = await run([dup, dup]);
    expect(r.duplicates).toBe(1);
    c = await byExt('c2');
    expect(c.cart_event_count).toBe(2);
  });

  it('refund and cancel adjust aggregates', async () => {
    await run([ev('CUSTOMER_CREATED', { external_customer_id: 'c3', email: 'r@example.com' }),
      ev('PURCHASE_COMPLETED', { external_customer_id: 'c3' }, { order: { external_order_id: 'o3', total: 1000, items: [] } }),
      ev('PURCHASE_COMPLETED', { external_customer_id: 'c3' }, { order: { external_order_id: 'o4', total: 500, items: [] } }),
      ev('ORDER_REFUNDED', { external_customer_id: 'c3' }, { external_order_id: 'o3', amount: 400 }),
      ev('ORDER_CANCELLED', { external_customer_id: 'c3' }, { external_order_id: 'o4' })]);
    const c = await byExt('c3');
    expect(c.order_count).toBe(1);
    expect(Number(c.total_revenue)).toBe(1000);
    expect(Number(c.refund_amount)).toBe(400);
    expect(Number(c.lifetime_value)).toBe(600);
    expect(c.cancelled_count).toBe(1);
  });

  it('opt-out adds global suppression; re-grant lifts it', async () => {
    await run([ev('CUSTOMER_CREATED', { external_customer_id: 'c4', email: 'o@example.com' }, { consent: { advertising_personalization: true, data_sharing: true, marketing: true } })]);
    await run([ev('CONSENT_REVOKED', { external_customer_id: 'c4' }, { purposes: { advertising_personalization: false }, source: 'preference_center' })]);
    let c = await byExt('c4');
    expect(c.suppressed).toBe(true);
    expect(c.consent_status).toBe('DENIED');
    const s = await t.db.selectFrom('suppression_records').selectAll().where('customer_id', '=', c.id).execute();
    expect(s[0]!.reason).toBe('ADVERTISING_OPT_OUT');
    await run([ev('CONSENT_GRANTED', { external_customer_id: 'c4' }, { purposes: { advertising_personalization: true } })]);
    c = await byExt('c4');
    expect(c.suppressed).toBe(false);
    expect(c.consent_status).toBe('GRANTED');
  });

  it('customer changes email and phone → identity history + identifiers rotate, old email still resolves', async () => {
    await run([ev('CUSTOMER_CREATED', { external_customer_id: 'c5', email: 'old@example.com', phone: '+919876500000' })]);
    await run([ev('CUSTOMER_UPDATED', { external_customer_id: 'c5', email: 'new@example.com', phone: '+919876511111' })]);
    const c = await byExt('c5');
    expect(c.email_hash!.equals(sha256('new@example.com'))).toBe(true);
    const hist = await t.db.selectFrom('identity_history').selectAll().where('customer_id', '=', c.id).execute();
    expect(hist.map((h) => h.kind).sort()).toEqual(['EMAIL', 'PHONE']);
    expect(hist.find((h) => h.kind === 'EMAIL')!.previous_hash!.equals(sha256('old@example.com'))).toBe(true);
    // an event arriving with only the OLD email resolves to the same customer via history
    await run([ev('ADD_TO_CART', { email: 'old@example.com' }, { product: { external_product_id: 'p' } })]);
    expect((await customer(c.id)).cart_event_count).toBe(1);
    expect((await t.db.selectFrom('customers').select('id').where('organization_id', '=', org).execute()).length).toBe(1);
  });

  it('customer deletion erases PII, suppresses, and blocks re-creation from later imports', async () => {
    await run([ev('CUSTOMER_CREATED', { external_customer_id: 'c6', email: 'del@example.com' })]);
    const before = await byExt('c6');
    await run([ev('CUSTOMER_DELETED', { external_customer_id: 'c6' })]);
    const c = await customer(before.id);
    expect(c.deleted).toBe(true); expect(c.suppressed).toBe(true); expect(c.email_encrypted).toBeNull(); expect(c.email_hash).not.toBeNull();
    expect((await t.db.selectFrom('customer_identifiers').selectAll().where('customer_id', '=', c.id).execute()).length).toBe(0);
    expect((await t.db.selectFrom('deletion_requests').selectAll().where('customer_id', '=', c.id).execute())[0]!.status).toBe('COMPLETED');
    // a later import with the same email (new external id) is born suppressed
    await run([ev('CUSTOMER_CREATED', { external_customer_id: 'c6-new', email: 'del@example.com' })]);
    expect((await byExt('c6-new')).suppressed).toBe(true);
  });

  it('behavioral events for unknown customers create a shell and bump updated_at for the audience engine', async () => {
    const r = await run([ev('PRODUCT_VIEWED', { email: 'ghost@example.com' }, { product: { external_product_id: 'p9' } })]);
    expect(r.accepted).toBe(1);
    const c = await t.db.selectFrom('customers').selectAll().where('organization_id', '=', org).executeTakeFirstOrThrow();
    expect(c.last_product_view_at).not.toBeNull();
    expect(c.updated_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
