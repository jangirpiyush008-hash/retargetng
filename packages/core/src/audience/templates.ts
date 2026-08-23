import type { RuleDefinition } from '../rules/schema.js';

export interface CampaignRecommendation {
  purpose: string;
  channels: string[];
  objective: string;
  recencyWindow?: string;
  suggestedExclusions: string[]; // template keys / slugs
  creativeAngle: string;
}
export interface TemplateParamDef { key: string; label: string; type: 'number' | 'product' | 'category' | 'products'; default?: unknown; min?: number; max?: number; required?: boolean; help?: string }
export interface AudienceTemplate {
  key: string;
  name: string;
  category: 'Lifecycle' | 'Value' | 'Product' | 'Behavior' | 'Recency';
  description: string;
  params: TemplateParamDef[];
  schedule: 'REALTIME' | 'HOURLY' | 'EVERY_6_HOURS' | 'DAILY';
  priority: number;
  build(params: Record<string, unknown>): RuleDefinition;
  recommendation: CampaignRecommendation;
}

const c = (field: string, operator: string, value?: unknown, params?: Record<string, unknown>) => ({ type: 'condition' as const, field, operator, value, params });
const and = (...children: unknown[]): RuleDefinition => ({ type: 'group', operator: 'AND', children: children as never });
const days = (n: number) => ({ value: n, unit: 'days' as const });
const num = (p: Record<string, unknown>, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
const ids = (p: Record<string, unknown>, k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).map(Number) : typeof p[k] === 'number' ? [p[k] as number] : []);

export const TEMPLATES: AudienceTemplate[] = [
  {
    key: 'CART_ABANDONER', name: 'Cart Abandoner', category: 'Behavior',
    description: 'Added to cart, no purchase since, within a recency window.',
    params: [{ key: 'minDays', label: 'At least (days ago)', type: 'number', default: 1, min: 0 }, { key: 'maxDays', label: 'At most (days ago)', type: 'number', default: 3, min: 1 }],
    schedule: 'HOURLY', priority: 10,
    build: (p) => and(c('has_open_cart', 'eq', true), c('last_cart_at', 'between_ago', { min: num(p, 'minDays', 1), max: num(p, 'maxDays', 3), unit: 'days' })),
    recommendation: { purpose: 'Recover abandoned carts', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions / Sales', recencyWindow: '1–3 days', suggestedExclusions: ['RECENT_PURCHASER'], creativeAngle: '"Still thinking about it?" — show the carted product, urgency, free shipping.' },
  },
  {
    key: 'RECENT_PURCHASER', name: 'Recent Purchaser', category: 'Recency',
    description: 'Purchased within the last N days (use to exclude from acquisition and to cross-sell).',
    params: [{ key: 'days', label: 'Within last (days)', type: 'number', default: 7, min: 1 }],
    schedule: 'HOURLY', priority: 20,
    build: (p) => and(c('last_order_at', 'within_last', days(num(p, 'days', 7)))),
    recommendation: { purpose: 'Post-purchase cross-sell / exclusion list', channels: ['META', 'GOOGLE_ADS'], objective: 'Engagement / Cross-sell', recencyWindow: '7 days', suggestedExclusions: [], creativeAngle: '"Complete the look" — complementary products, thank-you offer.' },
  },
  {
    key: 'LAPSED_CUSTOMER', name: 'Lapsed Customer', category: 'Lifecycle',
    description: 'Purchased before but not in the last N days.',
    params: [{ key: 'days', label: 'No purchase for (days)', type: 'number', default: 180, min: 7 }],
    schedule: 'DAILY', priority: 40,
    build: (p) => and(c('order_count', 'gte', 1), c('last_order_at', 'more_than_ago', days(num(p, 'days', 180)))),
    recommendation: { purpose: 'Win back lapsed buyers', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', recencyWindow: '180 days+', suggestedExclusions: ['RECENT_PURCHASER', 'CART_ABANDONER'], creativeAngle: '"We miss you" — what is new since they left, a comeback offer.' },
  },
  {
    key: 'VIP_CUSTOMER', name: 'VIP Customer', category: 'Value',
    description: 'Top customers by lifetime value and order count.',
    params: [{ key: 'minLtv', label: 'Minimum lifetime value', type: 'number', default: 25000 }, { key: 'minOrders', label: 'Minimum orders', type: 'number', default: 3 }],
    schedule: 'DAILY', priority: 30,
    build: (p) => and(c('lifetime_value', 'gte', num(p, 'minLtv', 25000)), c('order_count', 'gte', num(p, 'minOrders', 3))),
    recommendation: { purpose: 'Retain and reward', channels: ['META', 'GOOGLE_ADS'], objective: 'Engagement / Loyalty', suggestedExclusions: [], creativeAngle: 'Early access, loyalty perks, premium launches.' },
  },
  {
    key: 'HIGH_LTV', name: 'High LTV Customer', category: 'Value',
    description: 'Lifetime value above a threshold.',
    params: [{ key: 'minLtv', label: 'Minimum lifetime value', type: 'number', default: 10000 }],
    schedule: 'DAILY', priority: 35,
    build: (p) => and(c('lifetime_value', 'gte', num(p, 'minLtv', 10000))),
    recommendation: { purpose: 'Protect high-value relationships; seed lookalikes', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions / Lookalike seed', suggestedExclusions: ['RECENT_PURCHASER'], creativeAngle: 'Premium ranges, bundles, membership.' },
  },
  {
    key: 'ONE_TIME_BUYER', name: 'One-Time Buyer', category: 'Lifecycle',
    description: 'Exactly one order, older than N days — convert to repeat buyer.',
    params: [{ key: 'minDays', label: 'First order at least (days ago)', type: 'number', default: 14, min: 1 }],
    schedule: 'DAILY', priority: 50,
    build: (p) => and(c('order_count', 'eq', 1), c('last_order_at', 'more_than_ago', days(num(p, 'minDays', 14)))),
    recommendation: { purpose: 'Second-purchase conversion', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: ['RECENT_PURCHASER'], creativeAngle: 'Second-order incentive, bestsellers, social proof.' },
  },
  {
    key: 'REPEAT_BUYER', name: 'Repeat Buyer', category: 'Lifecycle',
    description: 'Two or more orders.',
    params: [{ key: 'minOrders', label: 'Minimum orders', type: 'number', default: 2, min: 2 }],
    schedule: 'DAILY', priority: 45,
    build: (p) => and(c('order_count', 'gte', num(p, 'minOrders', 2))),
    recommendation: { purpose: 'Loyalty and replenishment', channels: ['META', 'GOOGLE_ADS'], objective: 'Engagement', suggestedExclusions: [], creativeAngle: 'New arrivals, loyalty rewards.' },
  },
  {
    key: 'PRODUCT_BUYER', name: 'Product Buyer', category: 'Product',
    description: 'Bought specific products (optionally within a window).',
    params: [{ key: 'productIds', label: 'Products', type: 'products', required: true }, { key: 'withinDays', label: 'Within last (days, optional)', type: 'number' }],
    schedule: 'EVERY_6_HOURS', priority: 25,
    build: (p) => and(c('product_purchased', 'in', ids(p, 'productIds'), typeof p.withinDays === 'number' ? { withinDays: p.withinDays as number } : undefined)),
    recommendation: { purpose: 'Cross-sell / upsell buyers of a product', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: [], creativeAngle: 'Accessories and complements for the product they own.' },
  },
  {
    key: 'CATEGORY_BUYER', name: 'Category Buyer', category: 'Product',
    description: 'Bought from specific categories.',
    params: [{ key: 'categoryIds', label: 'Categories', type: 'category', required: true }, { key: 'withinDays', label: 'Within last (days, optional)', type: 'number' }],
    schedule: 'EVERY_6_HOURS', priority: 25,
    build: (p) => and(c('category_purchased', 'in', ids(p, 'categoryIds'), typeof p.withinDays === 'number' ? { withinDays: p.withinDays as number } : undefined)),
    recommendation: { purpose: 'Category affinity targeting', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: [], creativeAngle: 'New in category, category-specific offers.' },
  },
  {
    key: 'CROSS_SELL', name: 'Cross-Sell', category: 'Product',
    description: 'Bought product A but never product B — promote B.',
    params: [{ key: 'boughtProductIds', label: 'Bought (A)', type: 'products', required: true }, { key: 'notBoughtProductIds', label: 'Never bought (B)', type: 'products', required: true }],
    schedule: 'EVERY_6_HOURS', priority: 25,
    build: (p) => and(c('product_purchased', 'in', ids(p, 'boughtProductIds')), c('product_purchased', 'not_in', ids(p, 'notBoughtProductIds'))),
    recommendation: { purpose: 'Complementary product promotion', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: [], creativeAngle: '"Goes great with your <A>" — bundle B with A.' },
  },
  {
    key: 'WINBACK', name: 'Winback', category: 'Lifecycle',
    description: 'Previously valuable customers who have gone quiet.',
    params: [{ key: 'days', label: 'No purchase for (days)', type: 'number', default: 90 }, { key: 'minLtv', label: 'Minimum lifetime value', type: 'number', default: 5000 }],
    schedule: 'DAILY', priority: 40,
    build: (p) => and(c('lifetime_value', 'gte', num(p, 'minLtv', 5000)), c('last_order_at', 'more_than_ago', days(num(p, 'days', 90)))),
    recommendation: { purpose: 'Re-activate valuable lapsed customers', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: ['RECENT_PURCHASER'], creativeAngle: 'Personal comeback offer, reminder of favourites.' },
  },
  {
    key: 'REPLENISHMENT', name: 'Replenishment', category: 'Product',
    description: 'Bought consumable products N..M days ago — time to re-order.',
    params: [{ key: 'productIds', label: 'Products', type: 'products', required: true }, { key: 'minDays', label: 'Bought at least (days ago)', type: 'number', default: 25 }, { key: 'maxDays', label: 'Bought at most (days ago)', type: 'number', default: 45 }],
    schedule: 'DAILY', priority: 30,
    build: (p) => and(c('product_purchased', 'in', ids(p, 'productIds'), { withinDays: num(p, 'maxDays', 45) }), c('product_purchased', 'not_in', ids(p, 'productIds'), { withinDays: num(p, 'minDays', 25) })),
    recommendation: { purpose: 'Timely re-order reminders', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: [], creativeAngle: '"Running low?" — subscribe & save, one-click reorder.' },
  },
  {
    key: 'NEW_CUSTOMER', name: 'New Customer', category: 'Lifecycle',
    description: 'First order within the last N days.',
    params: [{ key: 'days', label: 'First order within (days)', type: 'number', default: 30 }],
    schedule: 'HOURLY', priority: 30,
    build: (p) => and(c('first_order_at', 'within_last', days(num(p, 'days', 30))), c('order_count', 'gte', 1)),
    recommendation: { purpose: 'Onboarding and second purchase', channels: ['META', 'GOOGLE_ADS'], objective: 'Engagement', suggestedExclusions: [], creativeAngle: 'Welcome series, how-to content, second-order offer.' },
  },
  {
    key: 'DORMANT', name: 'Dormant Customer', category: 'Behavior',
    description: 'No activity of any kind (views, carts, orders) for N days.',
    params: [{ key: 'days', label: 'Inactive for (days)', type: 'number', default: 60 }],
    schedule: 'DAILY', priority: 60,
    build: (p) => and(c('last_activity_at', 'more_than_ago', days(num(p, 'days', 60)))),
    recommendation: { purpose: 'Re-engagement', channels: ['META'], objective: 'Traffic / Engagement', suggestedExclusions: ['RECENT_PURCHASER'], creativeAngle: 'What is new, curated picks, light-touch reminder.' },
  },
  {
    key: 'HIGH_AOV', name: 'High AOV Customer', category: 'Value',
    description: 'Average order value above a threshold.',
    params: [{ key: 'minAov', label: 'Minimum AOV', type: 'number', default: 3000 }],
    schedule: 'DAILY', priority: 35,
    build: (p) => and(c('average_order_value', 'gte', num(p, 'minAov', 3000)), c('order_count', 'gte', 1)),
    recommendation: { purpose: 'Premium offers to big-basket buyers', channels: ['META', 'GOOGLE_ADS'], objective: 'Conversions', suggestedExclusions: [], creativeAngle: 'Bundles, premium lines, free shipping thresholds.' },
  },
];
export const TEMPLATE_MAP = new Map(TEMPLATES.map((t) => [t.key, t]));

/** Standard recency-window presets (slug, template, params). */
export const STANDARD_AUDIENCES: Array<{ slug: string; name: string; templateKey: string; params: Record<string, unknown>; priority: number; schedule: AudienceTemplate['schedule'] }> = [
  { slug: 'RECENT_PURCHASERS_1D', name: 'Recent Purchasers — 1 day', templateKey: 'RECENT_PURCHASER', params: { days: 1 }, priority: 20, schedule: 'HOURLY' },
  { slug: 'RECENT_PURCHASERS_7D', name: 'Recent Purchasers — 7 days', templateKey: 'RECENT_PURCHASER', params: { days: 7 }, priority: 21, schedule: 'HOURLY' },
  { slug: 'RECENT_PURCHASERS_30D', name: 'Recent Purchasers — 30 days', templateKey: 'RECENT_PURCHASER', params: { days: 30 }, priority: 22, schedule: 'HOURLY' },
  { slug: 'CART_ABANDONERS_1_3D', name: 'Cart Abandoners — 1–3 days', templateKey: 'CART_ABANDONER', params: { minDays: 1, maxDays: 3 }, priority: 10, schedule: 'HOURLY' },
  { slug: 'CART_ABANDONERS_4_7D', name: 'Cart Abandoners — 4–7 days', templateKey: 'CART_ABANDONER', params: { minDays: 4, maxDays: 7 }, priority: 11, schedule: 'HOURLY' },
  { slug: 'CART_ABANDONERS_8_14D', name: 'Cart Abandoners — 8–14 days', templateKey: 'CART_ABANDONER', params: { minDays: 8, maxDays: 14 }, priority: 12, schedule: 'HOURLY' },
  { slug: 'LAPSED_30D', name: 'Lapsed — 30 days', templateKey: 'LAPSED_CUSTOMER', params: { days: 30 }, priority: 40, schedule: 'DAILY' },
  { slug: 'LAPSED_60D', name: 'Lapsed — 60 days', templateKey: 'LAPSED_CUSTOMER', params: { days: 60 }, priority: 41, schedule: 'DAILY' },
  { slug: 'LAPSED_90D', name: 'Lapsed — 90 days', templateKey: 'LAPSED_CUSTOMER', params: { days: 90 }, priority: 42, schedule: 'DAILY' },
  { slug: 'LAPSED_180D', name: 'Lapsed — 180 days', templateKey: 'LAPSED_CUSTOMER', params: { days: 180 }, priority: 43, schedule: 'DAILY' },
  { slug: 'LAPSED_365D', name: 'Lapsed — 365 days', templateKey: 'LAPSED_CUSTOMER', params: { days: 365 }, priority: 44, schedule: 'DAILY' },
  { slug: 'VIP_CUSTOMERS', name: 'VIP Customers', templateKey: 'VIP_CUSTOMER', params: {}, priority: 30, schedule: 'DAILY' },
  { slug: 'HIGH_VALUE_CUSTOMERS', name: 'High Value Customers', templateKey: 'HIGH_LTV', params: { minLtv: 10000 }, priority: 35, schedule: 'DAILY' },
  { slug: 'REPEAT_CUSTOMERS', name: 'Repeat Customers', templateKey: 'REPEAT_BUYER', params: {}, priority: 45, schedule: 'DAILY' },
  { slug: 'ONE_TIME_CUSTOMERS', name: 'One-Time Customers', templateKey: 'ONE_TIME_BUYER', params: {}, priority: 50, schedule: 'DAILY' },
];
