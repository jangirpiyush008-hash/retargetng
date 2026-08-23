import { sql, type RawBuilder } from 'kysely';
import { getField, type FieldDef } from './fields.js';
import type { RuleNode, RuleDefinition, RuleCondition } from './schema.js';
import { toSeconds, type TimeUnit } from '../util/time.js';

export type BandTable = 'customers' | 'customer_product_purchases' | 'customer_category_purchases' | 'customer_product_interactions';
/** A relative-time boundary: customers whose `column` falls in [from - offset, to - offset] may change membership. */
export interface TimeBand {
  table: BandTable;
  column: string;
  offsetSeconds: number;
  filter?: { column: string; values: Array<number | string> };
}
export interface RuleDependencies { audienceIds: string[]; productIds: number[]; categoryIds: number[] }
export interface CompiledRule {
  /** boolean SQL expression over alias `c` (customers) */
  predicate: RawBuilder<boolean>;
  timeBands: TimeBand[];
  dependencies: RuleDependencies;
  conditionCount: number;
}
export interface CompileContext { now: Date; organizationId: string }

const like = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

export function compileRule(def: RuleDefinition, ctx: CompileContext): CompiledRule {
  const state = { bands: [] as TimeBand[], deps: { audienceIds: [] as string[], productIds: [] as number[], categoryIds: [] as number[] }, count: 0 };
  const predicate = compileNode(def, ctx, state);
  return {
    predicate: sql<boolean>`${predicate}`,
    timeBands: state.bands,
    dependencies: {
      audienceIds: [...new Set(state.deps.audienceIds)],
      productIds: [...new Set(state.deps.productIds)],
      categoryIds: [...new Set(state.deps.categoryIds)],
    },
    conditionCount: state.count,
  };
}

type State = { bands: TimeBand[]; deps: RuleDependencies; count: number };

function compileNode(node: RuleNode, ctx: CompileContext, st: State): RawBuilder<unknown> {
  if (node.type === 'group') {
    const parts = node.children.map((c) => compileNode(c, ctx, st));
    const joined = sql`(${sql.join(parts, sql.raw(node.operator === 'AND' ? ' AND ' : ' OR '))})`;
    return node.negate ? sql`(NOT ${joined})` : joined;
  }
  st.count++;
  const field = getField(node.field);
  if (!field) throw new Error(`Unknown field ${node.field}`);
  const expr = field.set ? compileSet(field, node, ctx, st) : compileScalar(field, node, ctx, st);
  return node.negate ? sql`(NOT ${expr})` : expr;
}

function relSeconds(v: unknown): number {
  const { value, unit } = v as { value: number; unit: TimeUnit };
  return toSeconds(value, unit);
}
const nowMinus = (now: Date, secs: number) => sql`(${now}::timestamptz - make_interval(secs => ${secs}))`;

function compileScalar(field: FieldDef, c: RuleCondition, ctx: CompileContext, st: State): RawBuilder<unknown> {
  let col: RawBuilder<unknown>;
  if (field.type === 'custom_string') col = sql`(c.attributes ->> ${c.params!.path!})`;
  else if (field.type === 'custom_number') col = sql`(CASE WHEN (c.attributes ->> ${c.params!.path!}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (c.attributes ->> ${c.params!.path!})::numeric END)`;
  else col = sql.raw(`c.${field.column!}`);
  const v = c.value as never;
  const isText = field.type === 'string' || field.type === 'enum' || field.type === 'custom_string';
  const arrCast = isText ? sql.raw('::text[]') : sql.raw('::numeric[]');
  switch (c.operator) {
    case 'eq': return sql`${col} = ${v}`;
    case 'neq': return sql`${col} IS DISTINCT FROM ${v}`;
    case 'gt': return sql`${col} > ${v}`;
    case 'gte': return sql`${col} >= ${v}`;
    case 'lt': return sql`${col} < ${v}`;
    case 'lte': return sql`${col} <= ${v}`;
    case 'between': { const [a, b] = c.value as [number, number]; return sql`${col} BETWEEN ${a} AND ${b}`; }
    case 'in': return sql`${col} = ANY(${c.value as unknown[]}${arrCast})`;
    case 'not_in': return sql`(${col} IS NULL OR NOT (${col} = ANY(${c.value as unknown[]}${arrCast})))`;
    case 'contains': return sql`${col} ILIKE ${'%' + like(String(c.value)) + '%'}`;
    case 'starts_with': return sql`${col} ILIKE ${like(String(c.value)) + '%'}`;
    case 'is_null': return sql`${col} IS NULL`;
    case 'is_not_null': return sql`${col} IS NOT NULL`;
    case 'within_last': {
      const s = relSeconds(c.value);
      st.bands.push({ table: 'customers', column: field.column!, offsetSeconds: s });
      return sql`${col} >= ${nowMinus(ctx.now, s)}`;
    }
    case 'more_than_ago': {
      const s = relSeconds(c.value);
      st.bands.push({ table: 'customers', column: field.column!, offsetSeconds: s });
      return sql`${col} < ${nowMinus(ctx.now, s)}`;
    }
    case 'between_ago': {
      const { min, max, unit } = c.value as { min: number; max: number; unit: TimeUnit };
      const smin = toSeconds(min, unit), smax = toSeconds(max, unit);
      st.bands.push({ table: 'customers', column: field.column!, offsetSeconds: smin }, { table: 'customers', column: field.column!, offsetSeconds: smax });
      return sql`${col} BETWEEN ${nowMinus(ctx.now, smax)} AND ${nowMinus(ctx.now, smin)}`;
    }
    case 'before': return sql`${col} < ${new Date(String(c.value))}::timestamptz`;
    case 'after': return sql`${col} > ${new Date(String(c.value))}::timestamptz`;
    default: throw new Error(`Unsupported operator ${c.operator}`);
  }
}

function compileSet(field: FieldDef, c: RuleCondition, ctx: CompileContext, st: State): RawBuilder<unknown> {
  const ids = Array.isArray(c.value) ? (c.value as unknown[]) : [];
  const withinDays = c.params?.withinDays;
  const minCount = c.params?.minCount;
  const negated = c.operator === 'not_in' || c.operator === 'none';
  const filtered = c.operator === 'in' || c.operator === 'not_in';
  const windowSecs = withinDays ? withinDays * 86400 : undefined;

  let sub: RawBuilder<unknown>;
  switch (field.set) {
    case 'product_purchased': case 'category_purchased': {
      const table = field.set === 'product_purchased' ? 'customer_product_purchases' : 'customer_category_purchases';
      const idCol = field.set === 'product_purchased' ? 'product_id' : 'category_id';
      const numIds = ids.map(Number);
      if (field.set === 'product_purchased') st.deps.productIds.push(...numIds); else st.deps.categoryIds.push(...numIds);
      const conds: RawBuilder<unknown>[] = [sql`p.customer_id = c.id`];
      if (filtered) conds.push(sql`${sql.raw('p.' + idCol)} = ANY(${numIds}::bigint[])`);
      if (windowSecs) { conds.push(sql`p.last_purchased_at >= ${nowMinus(ctx.now, windowSecs)}`);
        st.bands.push({ table, column: 'last_purchased_at', offsetSeconds: windowSecs, filter: filtered ? { column: idCol, values: numIds } : undefined }); }
      if (minCount) conds.push(sql`p.purchase_count >= ${minCount}`);
      sub = sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} p WHERE ${sql.join(conds, sql.raw(' AND '))})`;
      break;
    }
    case 'product_viewed': case 'product_carted': {
      const kind = field.set === 'product_viewed' ? 'VIEWED' : 'CARTED';
      const numIds = ids.map(Number);
      st.deps.productIds.push(...numIds);
      const conds: RawBuilder<unknown>[] = [sql`i.customer_id = c.id`, sql`i.interaction = ${kind}`];
      if (filtered) conds.push(sql`i.product_id = ANY(${numIds}::bigint[])`);
      if (windowSecs) { conds.push(sql`i.last_at >= ${nowMinus(ctx.now, windowSecs)}`);
        st.bands.push({ table: 'customer_product_interactions', column: 'last_at', offsetSeconds: windowSecs, filter: filtered ? { column: 'product_id', values: numIds } : undefined }); }
      if (minCount) conds.push(sql`i.count >= ${minCount}`);
      sub = sql`EXISTS (SELECT 1 FROM customer_product_interactions i WHERE ${sql.join(conds, sql.raw(' AND '))})`;
      if (kind === 'CARTED' && c.params?.openOnly) sub = sql`(${sub} AND c.has_open_cart)`;
      break;
    }
    case 'in_audience': {
      const audIds = ids.map(String);
      st.deps.audienceIds.push(...audIds);
      sub = sql`EXISTS (SELECT 1 FROM audience_members m WHERE m.customer_id = c.id AND m.status = 'ACTIVE' AND m.audience_id = ANY(${audIds}::uuid[]))`;
      break;
    }
    default: throw new Error(`Unsupported set field ${field.key}`);
  }
  return negated ? sql`(NOT ${sub})` : sub;
}
