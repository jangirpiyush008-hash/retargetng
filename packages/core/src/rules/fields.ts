/**
 * Field catalog — the single definition of what the no-code builder can offer and what the
 * compiler will accept. Column names are whitelisted here; nothing from the client is ever
 * interpolated as an identifier.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'enum' | 'product' | 'category' | 'audience' | 'custom_string' | 'custom_number';
export type FieldGroup = 'Customer' | 'Purchase' | 'Product' | 'Behavior' | 'Consent' | 'Membership' | 'Custom';

export const SCALAR_OPERATORS = {
  string: ['eq', 'neq', 'in', 'not_in', 'contains', 'starts_with', 'is_null', 'is_not_null'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null'],
  boolean: ['eq'],
  enum: ['eq', 'neq', 'in', 'not_in'],
  timestamp: ['within_last', 'more_than_ago', 'between_ago', 'before', 'after', 'is_null', 'is_not_null'],
  product: ['in', 'not_in', 'any', 'none'],
  category: ['in', 'not_in', 'any', 'none'],
  audience: ['in', 'not_in'],
  custom_string: ['eq', 'neq', 'in', 'not_in', 'contains', 'is_null', 'is_not_null'],
  custom_number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null'],
} as const satisfies Record<FieldType, readonly string[]>;

export type Operator = (typeof SCALAR_OPERATORS)[FieldType][number];

export type SetSource = 'product_purchased' | 'category_purchased' | 'product_viewed' | 'product_carted' | 'in_audience';

export interface FieldDef {
  key: string;
  label: string;
  group: FieldGroup;
  type: FieldType;
  description: string;
  /** customers column for scalar fields */
  column?: string;
  enumValues?: readonly string[];
  /** set-valued fields compile to EXISTS subqueries */
  set?: SetSource;
  /** supports params.withinDays (time-bounded membership of the set) */
  supportsWindow?: boolean;
  /** supports params.minCount */
  supportsMinCount?: boolean;
}

const F = (d: FieldDef) => d;

export const FIELDS: readonly FieldDef[] = [
  // Customer
  F({ key: 'country', label: 'Country', group: 'Customer', type: 'string', column: 'country', description: 'ISO-3166 alpha-2 country code' }),
  F({ key: 'region', label: 'Region / State', group: 'Customer', type: 'string', column: 'region', description: 'Region or state (where permissible)' }),
  F({ key: 'city', label: 'City', group: 'Customer', type: 'string', column: 'city', description: 'City (where permissible)' }),
  F({ key: 'source', label: 'Source / Store / Brand', group: 'Customer', type: 'string', column: 'source', description: 'Originating store, brand or system' }),
  F({ key: 'status', label: 'Customer status', group: 'Customer', type: 'string', column: 'status', description: 'Status from the source system' }),
  F({ key: 'lifecycle_state', label: 'Lifecycle state', group: 'Customer', type: 'enum', column: 'lifecycle_state', description: 'Computed lifecycle state',
      enumValues: ['PROSPECT', 'CART_ABANDONER', 'PURCHASER', 'REPEAT_PURCHASER', 'VIP', 'INACTIVE_30D', 'INACTIVE_60D', 'LAPSED_90D', 'LAPSED_180D', 'LAPSED_365D'] }),
  F({ key: 'created_at', label: 'Customer since', group: 'Customer', type: 'timestamp', column: 'created_at', description: 'When the customer record was created' }),
  // Purchase
  F({ key: 'order_count', label: 'Order count', group: 'Purchase', type: 'number', column: 'order_count', description: 'Completed orders' }),
  F({ key: 'total_revenue', label: 'Total spend', group: 'Purchase', type: 'number', column: 'total_revenue', description: 'Gross revenue' }),
  F({ key: 'average_order_value', label: 'Average order value', group: 'Purchase', type: 'number', column: 'average_order_value', description: 'AOV' }),
  F({ key: 'lifetime_value', label: 'Lifetime value', group: 'Purchase', type: 'number', column: 'lifetime_value', description: 'Revenue net of refunds' }),
  F({ key: 'refund_count', label: 'Refunds', group: 'Purchase', type: 'number', column: 'refund_count', description: 'Refunded/cancelled orders' }),
  F({ key: 'purchase_frequency_days', label: 'Purchase frequency (days)', group: 'Purchase', type: 'number', column: 'purchase_frequency_days', description: 'Average days between orders' }),
  F({ key: 'first_order_at', label: 'First purchase', group: 'Purchase', type: 'timestamp', column: 'first_order_at', description: 'First completed order' }),
  F({ key: 'last_order_at', label: 'Last purchase', group: 'Purchase', type: 'timestamp', column: 'last_order_at', description: 'Most recent completed order' }),
  // Product
  F({ key: 'product_purchased', label: 'Purchased product', group: 'Product', type: 'product', set: 'product_purchased', supportsWindow: true, supportsMinCount: true, description: 'Bought any of the selected products' }),
  F({ key: 'category_purchased', label: 'Purchased category', group: 'Product', type: 'category', set: 'category_purchased', supportsWindow: true, supportsMinCount: true, description: 'Bought from any of the selected categories' }),
  F({ key: 'product_viewed', label: 'Viewed product', group: 'Product', type: 'product', set: 'product_viewed', supportsWindow: true, description: 'Viewed any of the selected products' }),
  F({ key: 'product_carted', label: 'Added product to cart', group: 'Product', type: 'product', set: 'product_carted', supportsWindow: true, description: 'Carted any of the selected products' }),
  // Behavior
  F({ key: 'has_open_cart', label: 'Has open (abandoned) cart', group: 'Behavior', type: 'boolean', column: 'has_open_cart', description: 'Cart with items and no purchase since' }),
  F({ key: 'last_cart_at', label: 'Last cart activity', group: 'Behavior', type: 'timestamp', column: 'last_cart_at', description: 'Most recent add-to-cart' }),
  F({ key: 'cart_event_count', label: 'Cart events', group: 'Behavior', type: 'number', column: 'cart_event_count', description: 'Number of cart events' }),
  F({ key: 'last_product_view_at', label: 'Last product view', group: 'Behavior', type: 'timestamp', column: 'last_product_view_at', description: 'Most recent product view' }),
  F({ key: 'last_activity_at', label: 'Last activity', group: 'Behavior', type: 'timestamp', column: 'last_activity_at', description: 'Any activity (view, cart, order)' }),
  // Consent (informational in rules — enforced separately by the compliance policy)
  F({ key: 'consent_status', label: 'Consent status', group: 'Consent', type: 'enum', column: 'consent_status', enumValues: ['GRANTED', 'DENIED', 'UNKNOWN', 'EXPIRED'], description: 'Derived advertising consent state' }),
  F({ key: 'marketing_allowed', label: 'Marketing consent', group: 'Consent', type: 'boolean', column: 'marketing_allowed', description: 'Marketing permitted' }),
  F({ key: 'advertising_personalization_allowed', label: 'Advertising consent', group: 'Consent', type: 'boolean', column: 'advertising_personalization_allowed', description: 'Ad personalization permitted' }),
  F({ key: 'data_sharing_allowed', label: 'Data-sharing consent', group: 'Consent', type: 'boolean', column: 'data_sharing_allowed', description: 'Sharing with ad platforms permitted' }),
  F({ key: 'suppressed', label: 'Suppressed', group: 'Consent', type: 'boolean', column: 'suppressed', description: 'On the global suppression list' }),
  // Membership
  F({ key: 'in_audience', label: 'In audience', group: 'Membership', type: 'audience', set: 'in_audience', description: 'Currently a member of the selected audiences' }),
  // Custom
  F({ key: 'attribute_text', label: 'Custom attribute (text)', group: 'Custom', type: 'custom_string', description: 'attributes.<key> compared as text' }),
  F({ key: 'attribute_number', label: 'Custom attribute (number)', group: 'Custom', type: 'custom_number', description: 'attributes.<key> compared as number' }),
];

export const FIELD_MAP: ReadonlyMap<string, FieldDef> = new Map(FIELDS.map((f) => [f.key, f]));
export function getField(key: string): FieldDef | undefined { return FIELD_MAP.get(key); }
export function operatorsFor(type: FieldType): readonly string[] { return SCALAR_OPERATORS[type]; }
