import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@aap/db';
import { IdentityResolver } from '../identity/resolver.js';
import { applyConsentEvent, type ConsentState, type ConsentPurposes } from '../consent/state.js';
import { computeLifecycleState, DEFAULT_LIFECYCLE, type LifecycleThresholds } from '../lifecycle/index.js';
import { sanitizeError, logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import type { StoredCustomerRef } from './ingest.js';
import type { EventType } from './schema.js';
import { sha256 } from '../crypto/hash.js';

type Trx = Transaction<DB>;
interface StoredEvent { id: number; organization_id: string; event_type: EventType; occurred_at: Date; payload: { customer: StoredCustomerRef; data: Record<string, unknown> }; source: string | null }
interface CustomerRow { id: number; email_hash: Buffer | null; phone_hash: Buffer | null; order_count: number; total_revenue: number; refund_amount: number; refund_count: number; cancelled_count: number;
  first_order_at: Date | null; last_order_at: Date | null; last_cart_at: Date | null; has_open_cart: boolean; open_cart_id: string | null; cart_event_count: number; lifetime_value: number;
  consent_status: string; marketing_allowed: boolean; advertising_personalization_allowed: boolean; data_sharing_allowed: boolean; consent_updated_at: Date | null; suppressed: boolean; deleted: boolean; lifecycle_state: string; external_customer_id: string | null }

const hex = (s?: string) => (s ? Buffer.from(s, 'hex') : null);
const b64 = (s?: string) => (s ? Buffer.from(s, 'base64') : null);

export interface ProcessorOptions { lifecycle?: LifecycleThresholds }

/**
 * Applies stored events to the customer 360. One transaction per (customer, batch of their events):
 * identity → effect → lifecycle → customers.updated_at bump → event marked PROCESSED.
 */
export class CustomerEventProcessor {
  private log = logger().child({ module: 'event-processor' });
  constructor(private db: Kysely<DB>, private opts: ProcessorOptions = {}) {}

  async processEventIds(organizationId: string, refs: Array<{ id: number; occurredAt: string | Date }>): Promise<{ processed: number; failed: number; skipped: number }> {
    if (!refs.length) return { processed: 0, failed: 0, skipped: 0 };
    const ids = refs.map((r) => r.id);
    const minAt = new Date(Math.min(...refs.map((r) => new Date(r.occurredAt).getTime())));
    const maxAt = new Date(Math.max(...refs.map((r) => new Date(r.occurredAt).getTime())));
    const events = (await this.db.selectFrom('customer_events')
      .select(['id', 'organization_id', 'event_type', 'occurred_at', 'payload', 'source', 'processing_status'])
      .where('organization_id', '=', organizationId).where('id', 'in', ids)
      .where('occurred_at', '>=', minAt).where('occurred_at', '<=', maxAt)
      .orderBy('occurred_at').orderBy('id').execute()) as unknown as Array<StoredEvent & { processing_status: string }>;
    return this.processEvents(events.filter((e) => e.processing_status === 'PENDING'));
  }

  async processEvents(events: StoredEvent[]): Promise<{ processed: number; failed: number; skipped: number }> {
    const out = { processed: 0, failed: 0, skipped: 0 };
    // group by identity key so each customer's events apply in order within one transaction
    const groups = new Map<string, StoredEvent[]>();
    for (const e of events) {
      const c = e.payload.customer ?? {};
      const key = c.external_customer_id ? `x:${c.external_customer_id}` : c.email_hash ? `e:${c.email_hash}` : c.phone_hash ? `p:${c.phone_hash}` : `?:${e.id}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
    }
    for (const [, evs] of groups) {
      try {
        await this.db.transaction().execute(async (trx) => {
          for (const e of evs) await this.applyOne(trx, e);
        });
        out.processed += evs.length;
        metrics.eventsProcessed.inc({}, evs.length);
      } catch (err) {
        // fall back to per-event processing so one bad event doesn't poison the customer's batch
        for (const e of evs) {
          try {
            await this.db.transaction().execute(async (trx) => { await this.applyOne(trx, e); });
            out.processed++;
          } catch (err2) {
            out.failed++;
            await this.db.updateTable('customer_events').set({ processing_status: 'FAILED', processing_error: sanitizeError(err2), processed_at: new Date() })
              .where('id', '=', e.id).where('occurred_at', '=', e.occurred_at).execute();
            this.log.warn({ eventId: e.id, type: e.event_type, err: sanitizeError(err2) }, 'event failed');
          }
        }
        void err;
      }
    }
    return out;
  }

  private async applyOne(trx: Trx, e: StoredEvent): Promise<void> {
    const org = e.organization_id;
    const ref = e.payload.customer ?? {};
    const data = e.payload.data ?? {};
    const resolver = new IdentityResolver(trx);
    const res = await resolver.resolve(org, { externalCustomerId: ref.external_customer_id, emailHash: hex(ref.email_hash), phoneHash: hex(ref.phone_hash) });
    let customerId = res.customerId;
    const isCustomerEvent = e.event_type === 'CUSTOMER_CREATED' || e.event_type === 'CUSTOMER_UPDATED';
    if (!customerId) {
      if (e.event_type === 'CUSTOMER_DELETED' || e.event_type === 'ORDER_CANCELLED' || e.event_type === 'ORDER_REFUNDED') {
        await this.markProcessed(trx, e, 'SKIPPED', 'customer not found');
        return;
      }
      customerId = await this.createCustomer(trx, org, ref, isCustomerEvent ? data : {}, e);
    } else if (isCustomerEvent || ref.email_hash || ref.phone_hash) {
      await this.updateIdentity(trx, org, customerId, ref, isCustomerEvent ? data : null, e);
    }
    // lock the customer row for the rest of the effect
    const c = await trx.selectFrom('customers').selectAll().where('id', '=', customerId).forUpdate().executeTakeFirstOrThrow() as unknown as CustomerRow;
    await trx.updateTable('customer_events').set({ customer_id: customerId }).where('id', '=', e.id).where('occurred_at', '=', e.occurred_at).execute();

    switch (e.event_type) {
      case 'CUSTOMER_CREATED': case 'CUSTOMER_UPDATED': await this.applyCustomerPayload(trx, org, c, data, e); break;
      case 'PRODUCT_VIEWED': await this.applyProductViewed(trx, org, c, data, e); break;
      case 'ADD_TO_CART': await this.applyAddToCart(trx, org, c, data, e); break;
      case 'CHECKOUT_STARTED': await this.applyCheckout(trx, org, c, data, e); break;
      case 'PURCHASE_COMPLETED': await this.applyPurchase(trx, org, c, data, e); break;
      case 'ORDER_CANCELLED': await this.applyCancel(trx, org, c, data, e); break;
      case 'ORDER_REFUNDED': await this.applyRefund(trx, org, c, data, e); break;
      case 'CONSENT_GRANTED': case 'CONSENT_REVOKED': await this.applyConsent(trx, org, c, data, e); break;
      case 'CUSTOMER_DELETED': await this.applyDelete(trx, org, c, e); break;
    }
    await this.finalize(trx, customerId, e);
  }

  private async markProcessed(trx: Trx, e: StoredEvent, status: 'PROCESSED' | 'SKIPPED' | 'FAILED' = 'PROCESSED', error?: string) {
    await trx.updateTable('customer_events').set({ processing_status: status, processing_error: error ?? null, processed_at: new Date() })
      .where('id', '=', e.id).where('occurred_at', '=', e.occurred_at).execute();
  }

  /** Recompute lifecycle, bump updated_at (makes the customer a candidate), mark event processed. */
  private async finalize(trx: Trx, customerId: number, e: StoredEvent) {
    const c = await trx.selectFrom('customers').select(['order_count', 'last_order_at', 'has_open_cart', 'lifetime_value', 'lifecycle_state', 'last_activity_at']).where('id', '=', customerId).executeTakeFirstOrThrow();
    const state = computeLifecycleState(c, new Date(), this.opts.lifecycle ?? DEFAULT_LIFECYCLE);
    await trx.updateTable('customers').set({
      lifecycle_state: state,
      lifecycle_state_changed_at: state !== c.lifecycle_state ? new Date() : undefined,
      updated_at: new Date(),
    }).where('id', '=', customerId).execute();
    await this.markProcessed(trx, e);
  }

  // ----------------------------------------------------------------- identity
  private async createCustomer(trx: Trx, org: string, ref: StoredCustomerRef, data: Record<string, unknown>, e: StoredEvent): Promise<number> {
    const suppressedByHash = await this.suppressedByHash(trx, org, ref);
    const r = await trx.insertInto('customers').values({
      organization_id: org,
      external_customer_id: ref.external_customer_id ?? null,
      source: (data.source as string | undefined) ?? e.source ?? null,
      email_encrypted: b64(ref.email_enc), email_hash: hex(ref.email_hash), email_valid: ref.email_valid ?? null,
      phone_encrypted: b64(ref.phone_enc), phone_hash: hex(ref.phone_hash), phone_valid: ref.phone_valid ?? null,
      country: ref.country ?? null,
      region: (data.region as string | undefined) ?? null, city: (data.city as string | undefined) ?? null,
      status: (data.status as string | undefined) ?? 'ACTIVE',
      attributes: JSON.stringify((data.attributes as object | undefined) ?? {}),
      suppressed: suppressedByHash, suppressed_at: suppressedByHash ? new Date() : null,
      created_at: (data.created_at ? new Date(data.created_at as string) : e.occurred_at),
      source_updated_at: e.occurred_at,
    }).returning('id').executeTakeFirstOrThrow();
    await this.writeIdentifiers(trx, org, r.id, ref);
    return r.id;
  }

  private async updateIdentity(trx: Trx, org: string, customerId: number, ref: StoredCustomerRef, data: Record<string, unknown> | null, e: StoredEvent) {
    const cur = await trx.selectFrom('customers').select(['email_hash', 'phone_hash', 'external_customer_id', 'source_updated_at']).where('id', '=', customerId).executeTakeFirstOrThrow();
    // out-of-order protection for identity-bearing events: only newer data overwrites identifiers
    if (cur.source_updated_at && e.occurred_at < cur.source_updated_at && data) return;
    const patch: Record<string, unknown> = {};
    const newEmail = hex(ref.email_hash), newPhone = hex(ref.phone_hash);
    if (newEmail && (!cur.email_hash || !cur.email_hash.equals(newEmail))) {
      await trx.insertInto('identity_history').values({ organization_id: org, customer_id: customerId, kind: 'EMAIL', previous_hash: cur.email_hash, new_hash: newEmail, source: e.source, reason: e.event_type, occurred_at: e.occurred_at }).execute();
      Object.assign(patch, { email_hash: newEmail, email_encrypted: b64(ref.email_enc), email_valid: ref.email_valid ?? null });
    }
    if (newPhone && (!cur.phone_hash || !cur.phone_hash.equals(newPhone))) {
      await trx.insertInto('identity_history').values({ organization_id: org, customer_id: customerId, kind: 'PHONE', previous_hash: cur.phone_hash, new_hash: newPhone, source: e.source, reason: e.event_type, occurred_at: e.occurred_at }).execute();
      Object.assign(patch, { phone_hash: newPhone, phone_encrypted: b64(ref.phone_enc), phone_valid: ref.phone_valid ?? null });
    }
    if (ref.external_customer_id && !cur.external_customer_id) patch.external_customer_id = ref.external_customer_id;
    if (ref.country) patch.country = ref.country;
    if (Object.keys(patch).length) {
      await trx.updateTable('customers').set(patch).where('id', '=', customerId).execute();
      await this.writeIdentifiers(trx, org, customerId, ref);
      if (await this.suppressedByHash(trx, org, ref)) await trx.updateTable('customers').set({ suppressed: true, suppressed_at: new Date() }).where('id', '=', customerId).where('suppressed', '=', false).execute();
    }
  }

  private async writeIdentifiers(trx: Trx, org: string, customerId: number, ref: StoredCustomerRef) {
    const rows: Array<{ organization_id: string; customer_id: number; kind: 'EMAIL' | 'PHONE'; hash_profile: string; hash: Buffer; updated_at: Date }> = [];
    const now = new Date();
    if (ref.email_hash) rows.push({ organization_id: org, customer_id: customerId, kind: 'EMAIL', hash_profile: 'EMAIL_SHA256', hash: hex(ref.email_hash)!, updated_at: now });
    if (ref.email_hash_google) rows.push({ organization_id: org, customer_id: customerId, kind: 'EMAIL', hash_profile: 'EMAIL_SHA256_GOOGLE', hash: hex(ref.email_hash_google)!, updated_at: now });
    if (ref.phone_hash) rows.push({ organization_id: org, customer_id: customerId, kind: 'PHONE', hash_profile: 'PHONE_E164_SHA256', hash: hex(ref.phone_hash)!, updated_at: now });
    if (ref.phone_hash_digits) rows.push({ organization_id: org, customer_id: customerId, kind: 'PHONE', hash_profile: 'PHONE_DIGITS_SHA256', hash: hex(ref.phone_hash_digits)!, updated_at: now });
    if (!rows.length) return;
    await trx.insertInto('customer_identifiers').values(rows)
      .onConflict((oc) => oc.columns(['customer_id', 'kind', 'hash_profile']).doUpdateSet({ hash: (eb) => eb.ref('excluded.hash'), updated_at: now })).execute();
  }

  private async suppressedByHash(trx: Trx, org: string, ref: StoredCustomerRef): Promise<boolean> {
    const hashes = [hex(ref.email_hash), hex(ref.phone_hash)].filter((h) => h != null) as Buffer[];
    if (!hashes.length) return false;
    const r = await trx.selectFrom('suppression_records').select('id').where('organization_id', '=', org).where('revoked_at', 'is', null)
      .where('identifier_hash', 'in', hashes).where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())])).limit(1).executeTakeFirst();
    return !!r;
  }

  // ------------------------------------------------------------------ effects
  private async applyCustomerPayload(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, e: StoredEvent) {
    const patch: Record<string, unknown> = { source_updated_at: e.occurred_at };
    for (const k of ['region', 'city', 'status', 'source'] as const) if (data[k] !== undefined) patch[k] = data[k];
    if (data.attributes) patch.attributes = sql`attributes || ${JSON.stringify(data.attributes)}::jsonb`;
    await trx.updateTable('customers').set(patch).where('id', '=', c.id).execute();
    if (data.consent) await this.applyConsentState(trx, org, c, 'CONSENT_UPDATED', data.consent as ConsentPurposes, e, 'customer_record');
  }

  private async upsertProduct(trx: Trx, org: string, p: { external_product_id: string; name?: string; sku?: string; brand?: string; price?: number; external_category_id?: string; category_name?: string }): Promise<{ id: number; category_id: number | null }> {
    let categoryId: number | null = null;
    if (p.external_category_id) {
      const cat = await trx.insertInto('categories').values({ organization_id: org, external_category_id: p.external_category_id, name: p.category_name ?? p.external_category_id })
        .onConflict((oc) => oc.columns(['organization_id', 'external_category_id']).doUpdateSet({ name: sql`coalesce(excluded.name, categories.name)`, updated_at: new Date() }))
        .returning('id').executeTakeFirstOrThrow();
      categoryId = cat.id;
    }
    const r = await trx.insertInto('products').values({ organization_id: org, external_product_id: p.external_product_id, name: p.name ?? p.external_product_id, sku: p.sku ?? null, brand: p.brand ?? null, price: p.price ?? null, category_id: categoryId })
      .onConflict((oc) => oc.columns(['organization_id', 'external_product_id']).doUpdateSet({
        name: sql`coalesce(excluded.name, products.name)`,
        category_id: sql`coalesce(excluded.category_id, products.category_id)`,
        price: sql`coalesce(excluded.price, products.price)`,
        updated_at: new Date(),
      })).returning(['id', 'category_id']).executeTakeFirstOrThrow();
    return r;
  }

  private async touchInteraction(trx: Trx, org: string, customerId: number, productId: number, kind: 'VIEWED' | 'CARTED', at: Date) {
    await trx.insertInto('customer_product_interactions').values({ organization_id: org, customer_id: customerId, product_id: productId, interaction: kind, first_at: at, last_at: at, count: 1 })
      .onConflict((oc) => oc.columns(['customer_id', 'product_id', 'interaction']).doUpdateSet({
        last_at: sql`GREATEST(customer_product_interactions.last_at, ${at})`, first_at: sql`LEAST(customer_product_interactions.first_at, ${at})`, count: sql`customer_product_interactions.count + 1` })).execute();
  }

  private async applyProductViewed(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, e: StoredEvent) {
    const p = await this.upsertProduct(trx, org, data.product as never);
    await this.touchInteraction(trx, org, c.id, p.id, 'VIEWED', e.occurred_at);
    await trx.updateTable('customers').set({ last_product_view_at: sql`GREATEST(coalesce(last_product_view_at, ${e.occurred_at}), ${e.occurred_at})`, last_activity_at: sql`GREATEST(coalesce(last_activity_at, ${e.occurred_at}), ${e.occurred_at})` }).where('id', '=', c.id).execute();
  }

  private async applyAddToCart(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, e: StoredEvent) {
    const p = await this.upsertProduct(trx, org, data.product as never);
    const cartId = (data.cart_id as string | undefined) ?? c.open_cart_id ?? `cart_${c.id}_${e.occurred_at.getTime()}`;
    await trx.insertInto('cart_events').values({ organization_id: org, customer_id: c.id, cart_id: cartId, event_type: 'ADD_TO_CART', product_id: p.id, quantity: (data.quantity as number) ?? 1, value: (data.value as number) ?? null, event_id: String(e.id), occurred_at: e.occurred_at }).execute();
    await this.touchInteraction(trx, org, c.id, p.id, 'CARTED', e.occurred_at);
    // a cart add after the last order re-opens the cart; an older (out-of-order) add never re-opens a converted cart
    const reopen = !c.last_order_at || e.occurred_at > c.last_order_at;
    await trx.updateTable('customers').set({
      last_cart_at: sql`GREATEST(coalesce(last_cart_at, ${e.occurred_at}), ${e.occurred_at})`,
      has_open_cart: reopen ? true : undefined,
      open_cart_id: reopen ? cartId : undefined,
      cart_event_count: sql`cart_event_count + 1`,
      last_activity_at: sql`GREATEST(coalesce(last_activity_at, ${e.occurred_at}), ${e.occurred_at})`,
    }).where('id', '=', c.id).execute();
  }

  private async applyCheckout(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, e: StoredEvent) {
    await trx.insertInto('cart_events').values({ organization_id: org, customer_id: c.id, cart_id: (data.cart_id as string | undefined) ?? c.open_cart_id, event_type: 'CHECKOUT_STARTED', value: (data.value as number) ?? null, event_id: String(e.id), occurred_at: e.occurred_at }).execute();
    await trx.updateTable('customers').set({ cart_event_count: sql`cart_event_count + 1`, last_activity_at: sql`GREATEST(coalesce(last_activity_at, ${e.occurred_at}), ${e.occurred_at})` }).where('id', '=', c.id).execute();
  }

  private async applyPurchase(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, e: StoredEvent) {
    const order = data.order as { external_order_id: string; total: number; subtotal?: number; discount?: number; currency?: string; cart_id?: string; items: Array<{ product: never; quantity: number; unit_price: number; total?: number }> };
    const existing = await trx.selectFrom('orders').select('id').where('organization_id', '=', org).where('external_order_id', '=', order.external_order_id).executeTakeFirst();
    if (existing) return; // duplicate purchase (different event_id, same order) — idempotent
    const o = await trx.insertInto('orders').values({
      organization_id: org, customer_id: c.id, external_order_id: order.external_order_id, status: 'COMPLETED', currency: order.currency ?? 'INR',
      subtotal: order.subtotal ?? order.total, discount: order.discount ?? 0, total: order.total, item_count: order.items.reduce((s, i) => s + (i.quantity ?? 1), 0),
      cart_id: order.cart_id ?? null, source: e.source, ordered_at: e.occurred_at,
    }).returning('id').executeTakeFirstOrThrow();
    for (const it of order.items) {
      const p = await this.upsertProduct(trx, org, it.product);
      const lineTotal = it.total ?? it.unit_price * (it.quantity ?? 1);
      await trx.insertInto('order_items').values({ organization_id: org, order_id: o.id, customer_id: c.id, product_id: p.id, category_id: p.category_id, quantity: it.quantity ?? 1, unit_price: it.unit_price, total: lineTotal, ordered_at: e.occurred_at }).execute();
      await trx.insertInto('customer_product_purchases').values({ organization_id: org, customer_id: c.id, product_id: p.id, first_purchased_at: e.occurred_at, last_purchased_at: e.occurred_at, purchase_count: 1, quantity: it.quantity ?? 1, revenue: lineTotal })
        .onConflict((oc) => oc.columns(['customer_id', 'product_id']).doUpdateSet({
          first_purchased_at: sql`LEAST(customer_product_purchases.first_purchased_at, ${e.occurred_at})`, last_purchased_at: sql`GREATEST(customer_product_purchases.last_purchased_at, ${e.occurred_at})`,
          purchase_count: sql`customer_product_purchases.purchase_count + 1`, quantity: sql`customer_product_purchases.quantity + ${it.quantity ?? 1}`, revenue: sql`customer_product_purchases.revenue + ${lineTotal}` })).execute();
      if (p.category_id) {
        await trx.insertInto('customer_category_purchases').values({ organization_id: org, customer_id: c.id, category_id: p.category_id, first_purchased_at: e.occurred_at, last_purchased_at: e.occurred_at, purchase_count: 1, revenue: lineTotal })
          .onConflict((oc) => oc.columns(['customer_id', 'category_id']).doUpdateSet({
            first_purchased_at: sql`LEAST(customer_category_purchases.first_purchased_at, ${e.occurred_at})`, last_purchased_at: sql`GREATEST(customer_category_purchases.last_purchased_at, ${e.occurred_at})`,
            purchase_count: sql`customer_category_purchases.purchase_count + 1`, revenue: sql`customer_category_purchases.revenue + ${lineTotal}` })).execute();
      }
    }
    const orderCount = c.order_count + 1;
    const totalRevenue = Number(c.total_revenue) + order.total;
    const firstAt = c.first_order_at && c.first_order_at < e.occurred_at ? c.first_order_at : e.occurred_at;
    const lastAt = c.last_order_at && c.last_order_at > e.occurred_at ? c.last_order_at : e.occurred_at;
    const freq = orderCount > 1 ? (lastAt.getTime() - firstAt.getTime()) / 86400_000 / (orderCount - 1) : null;
    // cart converts if the purchase references the open cart or happens after the last cart activity
    const cartConverted = c.has_open_cart && ((order.cart_id && order.cart_id === c.open_cart_id) || !c.last_cart_at || e.occurred_at >= c.last_cart_at);
    if (cartConverted) await trx.insertInto('cart_events').values({ organization_id: org, customer_id: c.id, cart_id: c.open_cart_id, event_type: 'CART_CONVERTED', value: order.total, event_id: String(e.id), occurred_at: e.occurred_at }).execute();
    await trx.updateTable('customers').set({
      order_count: orderCount, total_revenue: totalRevenue, average_order_value: totalRevenue / orderCount,
      lifetime_value: totalRevenue - Number(c.refund_amount), first_order_at: firstAt, last_order_at: lastAt, purchase_frequency_days: freq,
      has_open_cart: cartConverted ? false : undefined, open_cart_id: cartConverted ? null : undefined,
      last_activity_at: sql`GREATEST(coalesce(last_activity_at, ${e.occurred_at}), ${e.occurred_at})`,
    }).where('id', '=', c.id).execute();
  }

  private async applyCancel(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, _e: StoredEvent) {
    const o = await trx.selectFrom('orders').select(['id', 'total', 'status']).where('organization_id', '=', org).where('external_order_id', '=', data.external_order_id as string).executeTakeFirst();
    if (!o || o.status === 'CANCELLED') return;
    await trx.updateTable('orders').set({ status: 'CANCELLED', cancelled_at: new Date(), updated_at: new Date() }).where('id', '=', o.id).execute();
    const agg = await trx.selectFrom('orders').select((eb) => [eb.fn.count<number>('id').as('n'), eb.fn.sum<number>('total').as('rev'), eb.fn.min('ordered_at').as('first'), eb.fn.max('ordered_at').as('last')])
      .where('customer_id', '=', c.id).where('status', '<>', 'CANCELLED').executeTakeFirstOrThrow();
    const n = Number(agg.n), rev = Number(agg.rev ?? 0);
    await trx.updateTable('customers').set({ order_count: n, total_revenue: rev, average_order_value: n ? rev / n : 0, lifetime_value: rev - Number(c.refund_amount), first_order_at: agg.first as Date | null, last_order_at: agg.last as Date | null, cancelled_count: sql`cancelled_count + 1` }).where('id', '=', c.id).execute();
  }

  private async applyRefund(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, _e: StoredEvent) {
    const o = await trx.selectFrom('orders').select(['id', 'total', 'refunded_amount', 'status']).where('organization_id', '=', org).where('external_order_id', '=', data.external_order_id as string).executeTakeFirst();
    if (!o) return;
    const amount = (data.amount as number | undefined) ?? (Number(o.total) - Number(o.refunded_amount));
    if (amount <= 0) return;
    const newRefunded = Math.min(Number(o.total), Number(o.refunded_amount) + amount);
    const full = newRefunded >= Number(o.total);
    await trx.updateTable('orders').set({ refunded_amount: newRefunded, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refunded_at: new Date(), updated_at: new Date() }).where('id', '=', o.id).execute();
    const refundAmount = Number(c.refund_amount) + amount;
    await trx.updateTable('customers').set({ refund_amount: refundAmount, refund_count: sql`refund_count + 1`, lifetime_value: Number(c.total_revenue) - refundAmount }).where('id', '=', c.id).execute();
  }

  private async applyConsent(trx: Trx, org: string, c: CustomerRow, data: Record<string, unknown>, e: StoredEvent) {
    await this.applyConsentState(trx, org, c, e.event_type as 'CONSENT_GRANTED' | 'CONSENT_REVOKED', (data.purposes as ConsentPurposes | undefined) ?? null, e, (data.source as string | undefined) ?? e.source ?? undefined, data);
  }

  private async applyConsentState(trx: Trx, org: string, c: CustomerRow, type: 'CONSENT_GRANTED' | 'CONSENT_REVOKED' | 'CONSENT_UPDATED', purposes: ConsentPurposes | null, e: StoredEvent, source?: string, extra: Record<string, unknown> = {}) {
    const current: ConsentState = { consent_status: c.consent_status as never, marketing_allowed: c.marketing_allowed, advertising_personalization_allowed: c.advertising_personalization_allowed, data_sharing_allowed: c.data_sharing_allowed, consent_updated_at: c.consent_updated_at };
    const next = applyConsentEvent(current, { type, purposes, occurredAt: e.occurred_at });
    await trx.insertInto('consent_events').values({ organization_id: org, customer_id: c.id, event_type: type, purposes: JSON.stringify(purposes ?? {}), source: source ?? null,
      legal_basis: (extra.legal_basis as string | undefined) ?? null, jurisdiction: (extra.jurisdiction as string | undefined) ?? null, evidence: extra.evidence ? JSON.stringify(extra.evidence) : null, event_id: String(e.id), occurred_at: e.occurred_at }).execute();
    await trx.updateTable('customers').set({ ...next }).where('id', '=', c.id).execute();
    // Advertising opt-out ⇒ global suppression (removed from every destination on next sync); re-grant lifts it.
    const wasAdv = c.advertising_personalization_allowed, isAdv = next.advertising_personalization_allowed;
    if (wasAdv && !isAdv) {
      await trx.insertInto('suppression_records').values({ organization_id: org, customer_id: c.id, identifier_kind: c.email_hash ? 'EMAIL' : c.phone_hash ? 'PHONE' : null, identifier_hash: c.email_hash ?? c.phone_hash, reason: 'ADVERTISING_OPT_OUT', source: source ?? 'consent_event' }).execute();
      await trx.updateTable('customers').set({ suppressed: true, suppressed_at: new Date() }).where('id', '=', c.id).execute();
    } else if (!wasAdv && isAdv) {
      await trx.updateTable('suppression_records').set({ revoked_at: new Date() }).where('customer_id', '=', c.id).where('reason', '=', 'ADVERTISING_OPT_OUT').where('revoked_at', 'is', null).execute();
      const still = await trx.selectFrom('suppression_records').select('id').where('customer_id', '=', c.id).where('revoked_at', 'is', null).limit(1).executeTakeFirst();
      if (!still) await trx.updateTable('customers').set({ suppressed: false, suppressed_at: null }).where('id', '=', c.id).execute();
    }
  }

  private async applyDelete(trx: Trx, org: string, c: CustomerRow, e: StoredEvent) {
    await trx.insertInto('suppression_records').values({ organization_id: org, customer_id: c.id, identifier_kind: c.email_hash ? 'EMAIL' : c.phone_hash ? 'PHONE' : null, identifier_hash: c.email_hash ?? c.phone_hash, reason: 'CUSTOMER_DELETION', source: e.source ?? 'event' }).execute();
    if (c.phone_hash && c.email_hash) await trx.insertInto('suppression_records').values({ organization_id: org, customer_id: c.id, identifier_kind: 'PHONE', identifier_hash: c.phone_hash, reason: 'CUSTOMER_DELETION', source: e.source ?? 'event' }).execute();
    // erase raw PII; keep hashes as tombstones so the person is never re-activated from a later import
    await trx.updateTable('customers').set({ deleted: true, deleted_at: new Date(), suppressed: true, suppressed_at: new Date(), email_encrypted: null, phone_encrypted: null,
      consent_status: 'DENIED', marketing_allowed: false, advertising_personalization_allowed: false, data_sharing_allowed: false, attributes: '{}', region: null, city: null }).where('id', '=', c.id).execute();
    await trx.deleteFrom('customer_identifiers').where('customer_id', '=', c.id).execute();
    await trx.insertInto('deletion_requests').values({ organization_id: org, customer_id: c.id, identifier_kind: c.email_hash ? 'EMAIL' : null, identifier_hash: c.email_hash ?? c.phone_hash, status: 'COMPLETED', requested_by: e.source ?? 'event', completed_at: new Date(), details: JSON.stringify({ via: 'CUSTOMER_DELETED' }) }).execute();
  }
}
export const _internal = { sha256 };
