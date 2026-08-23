import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { sha256 } from '../crypto/hash.js';

export async function createOrg(db: Kysely<DB>, name = 'Test Org'): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  const r = await db.insertInto('organizations').values({ name, slug }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

export interface CustomerSeed {
  external_customer_id?: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  order_count?: number;
  total_revenue?: number;
  lifetime_value?: number;
  average_order_value?: number;
  first_order_at?: Date | null;
  last_order_at?: Date | null;
  last_cart_at?: Date | null;
  has_open_cart?: boolean;
  last_activity_at?: Date | null;
  consent_status?: 'GRANTED' | 'DENIED' | 'UNKNOWN' | 'EXPIRED';
  consent_updated_at?: Date | null;
  marketing_allowed?: boolean;
  advertising_personalization_allowed?: boolean;
  data_sharing_allowed?: boolean;
  suppressed?: boolean;
  deleted?: boolean;
  status?: string;
  lifecycle_state?: string;
  attributes?: Record<string, unknown>;
  email_valid?: boolean | null;
  phone_valid?: boolean | null;
  updated_at?: Date;
}

let seq = 0;
/** Inserts a customer with sensible defaults (consented, email present) and returns its id. */
export async function insertCustomer(db: Kysely<DB>, organizationId: string, s: CustomerSeed = {}): Promise<number> {
  seq++;
  const email = s.email === undefined ? `user${seq}@example.com` : s.email;
  const phone = s.phone === undefined ? null : s.phone;
  const r = await db.insertInto('customers').values({
    organization_id: organizationId,
    external_customer_id: s.external_customer_id ?? `ext_${seq}`,
    email_hash: email ? sha256(email.toLowerCase()) : null,
    email_valid: email ? (s.email_valid ?? true) : null,
    phone_hash: phone ? sha256(phone) : null,
    phone_valid: phone ? (s.phone_valid ?? true) : null,
    country: s.country ?? 'IN',
    order_count: s.order_count ?? 0,
    total_revenue: s.total_revenue ?? 0,
    lifetime_value: s.lifetime_value ?? s.total_revenue ?? 0,
    average_order_value: s.average_order_value ?? 0,
    first_order_at: s.first_order_at ?? null,
    last_order_at: s.last_order_at ?? null,
    last_cart_at: s.last_cart_at ?? null,
    has_open_cart: s.has_open_cart ?? false,
    last_activity_at: s.last_activity_at ?? null,
    consent_status: s.consent_status ?? 'GRANTED',
    consent_updated_at: s.consent_updated_at ?? new Date(),
    marketing_allowed: s.marketing_allowed ?? true,
    advertising_personalization_allowed: s.advertising_personalization_allowed ?? true,
    data_sharing_allowed: s.data_sharing_allowed ?? true,
    suppressed: s.suppressed ?? false,
    deleted: s.deleted ?? false,
    status: s.status ?? 'ACTIVE',
    lifecycle_state: s.lifecycle_state ?? 'PROSPECT',
    attributes: JSON.stringify(s.attributes ?? {}),
    updated_at: s.updated_at ?? new Date(),
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}
