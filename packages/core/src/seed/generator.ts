import type pg from 'pg';
import type { EmbeddedPool } from '@aap/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@aap/db';
import { TableBuffer, type SeedMode } from './copy.js';
import { Rng } from './random.js';
import { CATEGORIES, buildProducts, FIRST_NAMES, LAST_NAMES, EMAIL_DOMAINS, COUNTRIES, IN_STATES, IN_CITIES, type SeedProduct } from './catalog.js';
import { hashIdentifiers } from '../identity/normalize.js';
import { piiCipher } from '../crypto/pii.js';
import { sha256 } from '../crypto/hash.js';
import { computeLifecycleState } from '../lifecycle/index.js';
import { applyConsentEvent, INITIAL_CONSENT } from '../consent/state.js';

export interface GenerateOptions {
  organizationId: string;
  customers: number;
  events: number;
  seed?: number;
  now?: Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}
export interface GenerateResult { customers: number; orders: number; orderItems: number; events: number; cartEvents: number; products: number; durationMs: number }

const DAY = 86400_000;

/**
 * Streams a realistic first-party dataset into Postgres with COPY. Aggregates on `customers`
 * (order_count, revenue, last_order_at, carts, consent, lifecycle) are computed by the generator
 * from the same orders/events it writes, so the 360 is internally consistent.
 *
 * IDs are predicted from the identity sequences (the target tables must not receive concurrent
 * inserts during generation) — this is a seeding tool, not a production ingestion path.
 */
export async function generateDataset(db: Kysely<DB>, pool: pg.Pool | EmbeddedPool, opts: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const rng = new Rng(opts.seed ?? 42);
  const now = opts.now ?? new Date();
  const org = opts.organizationId;
  const cipher = piiCipher();
  const N = opts.customers;
  const eventsPerCustomer = Math.max(3, opts.events / N);

  // ---------------------------------------------------------------- catalog
  const nextId = async (seq: string) => { const r = await pool.query<{ last_value: string; is_called: boolean }>(`SELECT last_value, is_called FROM ${seq}`); const row = r.rows[0]!; return row.is_called ? Number(row.last_value) + 1 : Number(row.last_value); };
  const totals = { orders: 0, items: 0, events: 0, cartEvents: 0 };
  // The embedded database has no COPY stream, so rows go in as batched multi-row INSERTs instead.
  const mode: SeedMode = (pool as unknown as { embedded?: boolean }).embedded ? 'insert' : 'copy';
  const client = await pool.connect();
  try {
    await client.query(`SET synchronous_commit = off`).catch(() => { /* not settable on the embedded database */ });
    const catStart = await nextId('categories_id_seq');
    let w = new TableBuffer('categories', ['organization_id', 'external_category_id', 'name', 'path'], mode);
    for (const c of CATEGORIES) w.write([org, c.key, c.name, c.key]);
    await w.flush(client);
    const catId = new Map(CATEGORIES.map((c, i) => [c.key, catStart + i]));
    const products = buildProducts(rng, 400);
    const prodStart = await nextId('products_id_seq');
    w = new TableBuffer('products', ['organization_id', 'external_product_id', 'name', 'sku', 'brand', 'category_id', 'price', 'currency', 'attributes'], mode);
    for (const p of products) w.write([org, p.externalId, p.name, p.sku, p.brand, catId.get(p.categoryKey)!, p.price, 'INR', { category: p.categoryKey }]);
    await w.flush(client);
    const productId = (p: SeedProduct) => prodStart + products.indexOf(p);
    const byCat = new Map<string, SeedProduct[]>();
    for (const p of products) (byCat.get(p.categoryKey) ?? byCat.set(p.categoryKey, []).get(p.categoryKey)!).push(p);
    // cross-sell / replenishment relationships
    w = new TableBuffer('product_relationships', ['organization_id', 'product_id', 'related_product_id', 'kind', 'weight', 'replenish_days'], mode);
    for (const c of CATEGORIES) {
      const ps = byCat.get(c.key) ?? [];
      if (c.complement) for (const p of ps.slice(0, 6)) for (const q of (byCat.get(c.complement) ?? []).slice(0, 3)) w.write([org, productId(p), productId(q), 'CROSS_SELL', 1, null]);
      if (c.replenishDays) for (const p of ps) w.write([org, productId(p), productId(p), 'REPLENISHMENT', 1, c.replenishDays]);
    }
    await w.flush(client);
    log('catalog written', { categories: CATEGORIES.length, products: products.length });

    // ---------------------------------------------------------------- customers (chunked)
    const custStart = await nextId('customers_id_seq');
    const orderStart = await nextId('orders_id_seq');
    let orderSeq = orderStart;
    const CHUNK = 20_000;
    const suppressionRows: unknown[][] = [];
    for (let start = 0; start < N; start += CHUNK) {
      const end = Math.min(N, start + CHUNK);
      const wc = new TableBuffer('customers', ['id', 'organization_id', 'external_customer_id', 'source', 'email_encrypted', 'email_hash', 'phone_encrypted', 'phone_hash', 'email_valid', 'phone_valid', 'country', 'region', 'city',
        'first_order_at', 'last_order_at', 'order_count', 'total_revenue', 'average_order_value', 'lifetime_value', 'refund_count', 'refund_amount', 'cancelled_count', 'purchase_frequency_days', 'last_cart_at', 'has_open_cart', 'open_cart_id', 'cart_event_count',
        'last_product_view_at', 'last_activity_at', 'lifecycle_state', 'lifecycle_state_changed_at', 'status', 'consent_status', 'marketing_allowed', 'advertising_personalization_allowed', 'data_sharing_allowed', 'consent_updated_at', 'suppressed', 'suppressed_at', 'deleted', 'deleted_at', 'attributes', 'source_updated_at', 'created_at', 'updated_at'], mode);
      const wi = new TableBuffer('customer_identifiers', ['organization_id', 'customer_id', 'kind', 'hash_profile', 'hash'], mode);
      const wo = new TableBuffer('orders', ['id', 'organization_id', 'customer_id', 'external_order_id', 'status', 'currency', 'subtotal', 'discount', 'total', 'refunded_amount', 'item_count', 'cart_id', 'source', 'ordered_at', 'refunded_at'], mode);
      const woi = new TableBuffer('order_items', ['organization_id', 'order_id', 'customer_id', 'product_id', 'category_id', 'quantity', 'unit_price', 'total', 'ordered_at'], mode);
      const wpp = new TableBuffer('customer_product_purchases', ['organization_id', 'customer_id', 'product_id', 'first_purchased_at', 'last_purchased_at', 'purchase_count', 'quantity', 'revenue'], mode);
      const wcp = new TableBuffer('customer_category_purchases', ['organization_id', 'customer_id', 'category_id', 'first_purchased_at', 'last_purchased_at', 'purchase_count', 'revenue'], mode);
      const wpi = new TableBuffer('customer_product_interactions', ['organization_id', 'customer_id', 'product_id', 'interaction', 'first_at', 'last_at', 'count'], mode);
      const wce = new TableBuffer('cart_events', ['organization_id', 'customer_id', 'cart_id', 'event_type', 'product_id', 'quantity', 'value', 'event_id', 'occurred_at'], mode);
      const wev = new TableBuffer('customer_events', ['organization_id', 'event_id', 'event_type', 'customer_id', 'external_customer_id', 'source', 'payload', 'payload_hash', 'processing_status', 'occurred_at', 'received_at', 'processed_at'], mode);
      const wco = new TableBuffer('consent_events', ['organization_id', 'customer_id', 'event_type', 'purposes', 'source', 'occurred_at'], mode);

      for (let i = start; i < end; i++) {
        const id = custStart + i;
        const ext = `cust_${i + 1}`;
        const source = rng.weighted([['web', 60], ['app', 30], ['store', 10]] as const);
        const createdAt = rng.date(new Date(now.getTime() - 730 * DAY), new Date(now.getTime() - 1 * DAY));
        const country = rng.weighted(COUNTRIES);
        const region = country === 'IN' ? rng.pick(IN_STATES) : null;
        const city = region ? rng.pick(IN_CITIES[region]!) : null;
        const first = rng.pick(FIRST_NAMES), last = rng.pick(LAST_NAMES);
        const domain = rng.weighted(EMAIL_DOMAINS);
        let email: string | null = `${first}.${last}${i + 1}@${domain}`;
        if (rng.chance(0.05)) email = `${first}${last}${i + 1}${domain}`; // invalid (missing @)
        if (rng.chance(0.04)) email = null; // phone-only customers
        let phone: string | null = null;
        if (rng.chance(0.7) || !email) phone = country === 'IN' ? `+91${rng.int(6, 9)}${String(rng.int(0, 999999999)).padStart(9, '0')}` : country === 'US' ? `+1${rng.int(201, 989)}555${String(rng.int(0, 9999)).padStart(4, '0')}` : `+971${rng.int(50, 58)}${String(rng.int(0, 9999999)).padStart(7, '0')}`;
        if (phone && rng.chance(0.03)) phone = `+91${rng.int(100, 999)}`; // invalid
        if (!email && !phone) phone = `+91${rng.int(6, 9)}${String(rng.int(0, 999999999)).padStart(9, '0')}`;
        const h = hashIdentifiers({ email, phone, country });
        const emailHash = h.email?.hashes.EMAIL_SHA256 ?? null, phoneHash = h.phone?.hashes.PHONE_E164_SHA256 ?? null;

        // ---- commerce history
        const isBuyer = rng.chance(0.55);
        const orderCount = isBuyer ? rng.weighted([[1, 42], [2, 22], [3, 13], [4, 8], [5, 5], [6, 3], [8, 3], [10, 2], [15, 1.5], [25, 0.5]] as const) : 0;
        const affinity = rng.pick(CATEGORIES).key;
        const orderDates: Date[] = [];
        for (let k = 0; k < orderCount; k++) orderDates.push(rng.date(createdAt, now));
        orderDates.sort((a, b) => a.getTime() - b.getTime());
        let totalRevenue = 0, refundAmount = 0, refundCount = 0, cancelledCount = 0;
        const productAgg = new Map<number, { first: Date; last: Date; count: number; qty: number; rev: number; cat: number }>();
        const carted = new Map<number, { first: Date; last: Date; count: number }>();
        const touchCart = (pid: number, at: Date) => { const v = carted.get(pid) ?? { first: at, last: at, count: 0 }; v.first = v.first < at ? v.first : at; v.last = v.last > at ? v.last : at; v.count++; carted.set(pid, v); };
        const events: Array<{ type: string; at: Date; data: Record<string, unknown> }> = [];
        events.push({ type: 'CUSTOMER_CREATED', at: createdAt, data: { source } });
        let completedOrders = 0; let firstOrderAt: Date | null = null; let lastOrderAt: Date | null = null;
        for (let k = 0; k < orderDates.length; k++) {
          const at = orderDates[k]!;
          const oid = orderSeq++;
          const nItems = rng.weighted([[1, 55], [2, 28], [3, 12], [4, 5]] as const);
          let subtotal = 0; let qtyTotal = 0;
          const items: Array<{ p: SeedProduct; qty: number; price: number }> = [];
          for (let j = 0; j < nItems; j++) {
            const cat = rng.chance(0.6) ? affinity : rng.pick(CATEGORIES).key;
            const p = rng.pick(byCat.get(cat)!);
            const qty = rng.weighted([[1, 80], [2, 15], [3, 5]] as const);
            const price = Math.round(p.price * (0.85 + rng.next() * 0.3));
            items.push({ p, qty, price }); subtotal += price * qty; qtyTotal += qty;
          }
          const discount = rng.chance(0.35) ? Math.round(subtotal * rng.pick([0.05, 0.1, 0.15, 0.2])) : 0;
          const total = subtotal - discount;
          const status = rng.chance(0.04) ? 'CANCELLED' : rng.chance(0.03) ? 'REFUNDED' : 'COMPLETED';
          const cartId = `cart_${id}_${k}`;
          const refunded = status === 'REFUNDED' ? total : 0;
          wo.write([oid, org, id, `ord_${oid}`, status, 'INR', subtotal, discount, total, refunded, qtyTotal, cartId, source, at, status === 'REFUNDED' ? new Date(at.getTime() + rng.int(1, 10) * DAY) : null]);
          totals.orders++;
          for (const it of items) {
            const pid = productId(it.p), cid = catId.get(it.p.categoryKey)!;
            woi.write([org, oid, id, pid, cid, it.qty, it.price, it.price * it.qty, at]); totals.items++;
            if (status !== 'CANCELLED') {
              const a = productAgg.get(pid) ?? { first: at, last: at, count: 0, qty: 0, rev: 0, cat: cid };
              a.first = a.first < at ? a.first : at; a.last = a.last > at ? a.last : at; a.count++; a.qty += it.qty; a.rev += it.price * it.qty; productAgg.set(pid, a);
            }
            // cart activity before purchase (cart_events keeps every item; the raw event log keeps one view + one add per order)
            const viewAt = new Date(at.getTime() - rng.int(5, 300) * 60_000);
            if (it === items[0]) {
              events.push({ type: 'PRODUCT_VIEWED', at: viewAt, data: { product: it.p.externalId } });
              events.push({ type: 'ADD_TO_CART', at: new Date(at.getTime() - rng.int(2, 120) * 60_000), data: { cart_id: cartId, product: it.p.externalId, quantity: it.qty, value: it.price * it.qty } });
            }
            wce.write([org, id, cartId, 'ADD_TO_CART', pid, it.qty, it.price * it.qty, null, new Date(at.getTime() - rng.int(2, 120) * 60_000)]); totals.cartEvents++;
            touchCart(pid, viewAt);
          }
          events.push({ type: 'CHECKOUT_STARTED', at: new Date(at.getTime() - 60_000), data: { cart_id: cartId, value: total } });
          wce.write([org, id, cartId, 'CHECKOUT_STARTED', null, null, total, null, new Date(at.getTime() - 60_000)]); totals.cartEvents++;
          events.push({ type: 'PURCHASE_COMPLETED', at, data: { order: `ord_${oid}`, total, items: items.length } });
          wce.write([org, id, cartId, 'CART_CONVERTED', null, null, total, null, at]); totals.cartEvents++;
          if (status === 'CANCELLED') { cancelledCount++; events.push({ type: 'ORDER_CANCELLED', at: new Date(at.getTime() + rng.int(1, 48) * 3600_000), data: { order: `ord_${oid}` } }); continue; }
          completedOrders++; totalRevenue += total; firstOrderAt ??= at; lastOrderAt = at;
          if (status === 'REFUNDED') { refundAmount += total; refundCount++; events.push({ type: 'ORDER_REFUNDED', at: new Date(at.getTime() + rng.int(1, 10) * DAY), data: { order: `ord_${oid}`, amount: total } }); }
        }
        for (const [pid, a] of productAgg) {
          wpp.write([org, id, pid, a.first, a.last, a.count, a.qty, a.rev]);
        }
        const catAgg = new Map<number, { first: Date; last: Date; count: number; rev: number }>();
        for (const a of productAgg.values()) { const c = catAgg.get(a.cat) ?? { first: a.first, last: a.last, count: 0, rev: 0 }; c.first = c.first < a.first ? c.first : a.first; c.last = c.last > a.last ? c.last : a.last; c.count += a.count; c.rev += a.rev; catAgg.set(a.cat, c); }
        for (const [cid, c] of catAgg) wcp.write([org, id, cid, c.first, c.last, c.count, c.rev]);

        // ---- open cart (abandoned) — only if later than the last order
        let hasOpenCart = false; let lastCartAt: Date | null = lastOrderAt ? new Date(lastOrderAt.getTime() - 60_000) : null; let openCartId: string | null = null; let cartEventCount = orderDates.length * 2;
        if (rng.chance(0.15)) {
          const at = rng.date(new Date(now.getTime() - 21 * DAY), new Date(now.getTime() - 2 * 3600_000));
          if (!lastOrderAt || at > lastOrderAt) {
            hasOpenCart = true; lastCartAt = at; openCartId = `cart_${id}_open`; cartEventCount++;
            const p = rng.pick(byCat.get(rng.chance(0.6) ? affinity : rng.pick(CATEGORIES).key)!);
            events.push({ type: 'PRODUCT_VIEWED', at: new Date(at.getTime() - rng.int(1, 30) * 60_000), data: { product: p.externalId } });
            events.push({ type: 'ADD_TO_CART', at, data: { cart_id: openCartId, product: p.externalId, quantity: 1, value: p.price } });
            wce.write([org, id, openCartId, 'ADD_TO_CART', productId(p), 1, p.price, null, at]); totals.cartEvents++;
            touchCart(productId(p), at);
          }
        }
        // ---- extra browsing to hit the event budget
        const target = Math.round(eventsPerCustomer * (0.4 + rng.next() * 1.2));
        const allowance = (opts.events * (i + 1)) / N; // cumulative budget up to this customer
        let lastViewAt: Date | null = null;
        const viewed = new Map<number, { first: Date; last: Date; count: number }>();
        while (events.length < target && totals.events + events.length < allowance) {
          const p = rng.pick(byCat.get(rng.chance(0.5) ? affinity : rng.pick(CATEGORIES).key)!);
          const at = rng.date(createdAt, now);
          events.push({ type: 'PRODUCT_VIEWED', at, data: { product: p.externalId } });
          const v = viewed.get(productId(p)) ?? { first: at, last: at, count: 0 }; v.first = v.first < at ? v.first : at; v.last = v.last > at ? v.last : at; v.count++; viewed.set(productId(p), v);
          if (!lastViewAt || at > lastViewAt) lastViewAt = at;
        }
        for (const [pid, v] of viewed) wpi.write([org, id, pid, 'VIEWED', v.first, v.last, v.count]);
        for (const [pid, v] of carted) wpi.write([org, id, pid, 'CARTED', v.first, v.last, v.count]);
        // ---- consent
        let consent = INITIAL_CONSENT;
        const consentKind = rng.weighted([['FULL', 72], ['MARKETING_ONLY', 8], ['DENIED', 5], ['UNKNOWN', 15]] as const);
        if (consentKind !== 'UNKNOWN') {
          const at = rng.date(createdAt, now);
          const purposes = consentKind === 'FULL' ? { marketing: true, advertising_personalization: true, data_sharing: true } : consentKind === 'MARKETING_ONLY' ? { marketing: true, advertising_personalization: false, data_sharing: false } : { marketing: false, advertising_personalization: false, data_sharing: false };
          const type = consentKind === 'DENIED' ? 'CONSENT_REVOKED' : 'CONSENT_GRANTED';
          consent = applyConsentEvent(consent, { type: type as never, purposes, occurredAt: at });
          wco.write([org, id, type, purposes, rng.pick(['checkout', 'preference_center', 'signup', 'import']), at]);
          events.push({ type, at, data: { purposes } });
        }
        // ---- suppression / deletion
        const suppressed = rng.chance(0.015);
        const deleted = !suppressed && rng.chance(0.003);
        if (suppressed || deleted) suppressionRows.push([org, id, emailHash ? 'EMAIL' : 'PHONE', emailHash ?? phoneHash, deleted ? 'CUSTOMER_DELETION' : rng.weighted([['UNSUBSCRIBE', 40], ['ADVERTISING_OPT_OUT', 30], ['PRIVACY_REQUEST', 10], ['CUSTOMER_COMPLAINT', 8], ['FRAUD', 5], ['INTERNAL_BLACKLIST', 5], ['LEGAL_RESTRICTION', 2]] as const), 'seed', rng.date(createdAt, now)]);
        const lastActivity = [lastOrderAt, lastCartAt, lastViewAt].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? createdAt;
        const lifetimeValue = totalRevenue - refundAmount;
        const state = computeLifecycleState({ order_count: completedOrders, last_order_at: lastOrderAt, has_open_cart: hasOpenCart, lifetime_value: lifetimeValue }, now);
        const freq = completedOrders > 1 && firstOrderAt && lastOrderAt ? (lastOrderAt.getTime() - firstOrderAt.getTime()) / DAY / (completedOrders - 1) : null;
        const updatedAt = rng.date(new Date(Math.max(lastActivity.getTime(), now.getTime() - 30 * DAY)), now);
        wc.write([id, org, ext, source,
          deleted || !h.email ? null : cipher.encrypt(h.email.normalized), emailHash, deleted || !h.phone ? null : cipher.encrypt(h.phone.e164), phoneHash, h.email?.valid ?? null, h.phone?.valid ?? null,
          country, region, city, firstOrderAt, lastOrderAt, completedOrders, totalRevenue, completedOrders ? totalRevenue / completedOrders : 0, lifetimeValue, refundCount, refundAmount, cancelledCount, freq, lastCartAt, hasOpenCart, openCartId, cartEventCount,
          lastViewAt, lastActivity, state, createdAt, rng.chance(0.97) ? 'ACTIVE' : 'DISABLED',
          deleted ? 'DENIED' : consent.consent_status, deleted ? false : consent.marketing_allowed, deleted ? false : consent.advertising_personalization_allowed, deleted ? false : consent.data_sharing_allowed, consent.consent_updated_at,
          suppressed || deleted, suppressed || deleted ? now : null, deleted, deleted ? now : null,
          { tier: rng.weighted([['bronze', 50], ['silver', 30], ['gold', 15], ['platinum', 5]] as const), acquisition_channel: rng.pick(['organic', 'paid_social', 'search', 'referral', 'affiliate']), app_user: rng.chance(0.4) },
          createdAt, createdAt, updatedAt]);
        if (!deleted) {
          if (h.email) { wi.write([org, id, 'EMAIL', 'EMAIL_SHA256', h.email.hashes.EMAIL_SHA256]); wi.write([org, id, 'EMAIL', 'EMAIL_SHA256_GOOGLE', h.email.hashes.EMAIL_SHA256_GOOGLE]); }
          if (h.phone) { wi.write([org, id, 'PHONE', 'PHONE_E164_SHA256', h.phone.hashes.PHONE_E164_SHA256]); wi.write([org, id, 'PHONE', 'PHONE_DIGITS_SHA256', h.phone.hashes.PHONE_DIGITS_SHA256]); }
        }
        // ---- raw event log (PROCESSED; payload carries only hashed identity + compact data)
        const custRef = { external_customer_id: ext, country }; // compact: identity is carried by customer_id; hashes live on customers
        let n = 0;
        for (const e of events) {
          const payload = { customer: custRef, data: e.data };
          wev.write([org, `seed_${id}_${n++}`, e.type, id, ext, source, payload, sha256(`${e.type}|${id}|${n}`), 'PROCESSED', e.at, e.at, e.at]);
          totals.events++;
        }
      }
      for (const b of [wc, wi, wo, woi, wpp, wcp, wpi, wce, wev, wco]) await b.flush(client);
      log(`customers ${end.toLocaleString()} / ${N.toLocaleString()}`, { orders: totals.orders, events: totals.events, elapsedS: Math.round((Date.now() - started) / 1000) });
    }
    if (suppressionRows.length) {
      const ws = new TableBuffer('suppression_records', ['organization_id', 'customer_id', 'identifier_kind', 'identifier_hash', 'reason', 'source', 'created_at'], mode);
      for (const r of suppressionRows) ws.write(r);
      await ws.flush(client);
    }
    // bump sequences past what we wrote
    await client.query(`SELECT setval('customers_id_seq', (SELECT max(id) FROM customers))`);
    await client.query(`SELECT setval('orders_id_seq', (SELECT max(id) FROM orders))`);
    await client.query(`SELECT setval('categories_id_seq', (SELECT max(id) FROM categories))`);
    await client.query(`SELECT setval('products_id_seq', (SELECT max(id) FROM products))`);
    log('analyzing tables');
    await client.query('ANALYZE customers; ANALYZE customer_identifiers; ANALYZE orders; ANALYZE order_items; ANALYZE customer_product_purchases; ANALYZE customer_category_purchases; ANALYZE customer_product_interactions; ANALYZE products; ANALYZE cart_events; ANALYZE customer_events;');
  } finally { client.release(); }
  void db; void sql;
  return { customers: N, orders: totals.orders, orderItems: totals.items, events: totals.events, cartEvents: totals.cartEvents, products: 400, durationMs: Date.now() - started };
}
