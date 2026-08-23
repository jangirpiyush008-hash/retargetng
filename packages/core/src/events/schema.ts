import { z } from 'zod';

export const EVENT_TYPES = ['CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'PRODUCT_VIEWED', 'ADD_TO_CART', 'CHECKOUT_STARTED',
  'PURCHASE_COMPLETED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'CONSENT_GRANTED', 'CONSENT_REVOKED', 'CUSTOMER_DELETED'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const money = z.number().finite().min(-1e9).max(1e9);
const dateish = z.union([z.string().datetime({ offset: true }), z.date()]).transform((v) => (typeof v === 'string' ? new Date(v) : v));

export const ConsentPurposesSchema = z.object({
  marketing: z.boolean().optional(),
  advertising_personalization: z.boolean().optional(),
  data_sharing: z.boolean().optional(),
}).strict();

export const CustomerRefSchema = z.object({
  external_customer_id: z.string().min(1).max(128).optional(),
  email: z.string().max(254).optional().nullable(),
  phone: z.string().max(32).optional().nullable(),
  country: z.string().length(2).optional().nullable(),
}).refine((c) => c.external_customer_id || c.email || c.phone, 'customer needs external_customer_id, email or phone');

export const ProductRefSchema = z.object({
  external_product_id: z.string().min(1).max(128),
  name: z.string().max(256).optional(),
  sku: z.string().max(128).optional(),
  brand: z.string().max(128).optional(),
  price: money.optional(),
  external_category_id: z.string().max(128).optional(),
  category_name: z.string().max(256).optional(),
});

export const CustomerPayloadSchema = z.object({
  region: z.string().max(128).optional().nullable(),
  city: z.string().max(128).optional().nullable(),
  status: z.string().max(32).optional(),
  source: z.string().max(64).optional(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  created_at: dateish.optional(),
  consent: ConsentPurposesSchema.optional(),
}).strict();

export const OrderItemSchema = z.object({
  product: ProductRefSchema,
  quantity: z.number().int().min(1).max(100000).default(1),
  unit_price: money.default(0),
  total: money.optional(),
});
export const OrderPayloadSchema = z.object({
  external_order_id: z.string().min(1).max(128),
  total: money,
  subtotal: money.optional(),
  discount: money.optional(),
  currency: z.string().length(3).optional(),
  cart_id: z.string().max(128).optional(),
  items: z.array(OrderItemSchema).max(500).default([]),
}).strict();

const payloadByType = {
  CUSTOMER_CREATED: CustomerPayloadSchema,
  CUSTOMER_UPDATED: CustomerPayloadSchema,
  PRODUCT_VIEWED: z.object({ product: ProductRefSchema }).strict(),
  ADD_TO_CART: z.object({ cart_id: z.string().max(128).optional(), product: ProductRefSchema, quantity: z.number().int().min(1).default(1), value: money.optional() }).strict(),
  CHECKOUT_STARTED: z.object({ cart_id: z.string().max(128).optional(), value: money.optional() }).strict(),
  PURCHASE_COMPLETED: z.object({ order: OrderPayloadSchema }).strict(),
  ORDER_CANCELLED: z.object({ external_order_id: z.string().min(1).max(128) }).strict(),
  ORDER_REFUNDED: z.object({ external_order_id: z.string().min(1).max(128), amount: money.optional(), partial: z.boolean().optional() }).strict(),
  CONSENT_GRANTED: z.object({ purposes: ConsentPurposesSchema.optional(), source: z.string().max(64).optional(), legal_basis: z.string().max(64).optional(), jurisdiction: z.string().max(64).optional(), evidence: z.record(z.unknown()).optional() }).strict(),
  CONSENT_REVOKED: z.object({ purposes: ConsentPurposesSchema.optional(), source: z.string().max(64).optional(), legal_basis: z.string().max(64).optional(), jurisdiction: z.string().max(64).optional(), evidence: z.record(z.unknown()).optional() }).strict(),
  CUSTOMER_DELETED: z.object({ reason: z.string().max(256).optional() }).strict(),
} as const;

export const InboundEventSchema = z.object({
  event_id: z.string().min(1).max(128),
  event_type: z.enum(EVENT_TYPES),
  occurred_at: dateish,
  source: z.string().max(64).optional(),
  customer: CustomerRefSchema,
  payload: z.record(z.unknown()).default({}),
}).superRefine((e, ctx) => {
  const schema = payloadByType[e.event_type];
  const r = schema.safeParse(e.payload);
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message, path: ['payload', ...i.path] });
});
export type InboundEvent = z.infer<typeof InboundEventSchema>;
export const InboundEventBatchSchema = z.array(InboundEventSchema).min(1).max(1000);

export function payloadSchemaFor(type: EventType) { return payloadByType[type]; }
