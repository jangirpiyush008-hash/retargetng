import { getField } from './fields.js';
import type { RuleNode, RuleDefinition } from './schema.js';

const OP: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', in: 'in', not_in: 'not in',
  contains: 'contains', starts_with: 'starts with', is_null: 'is empty', is_not_null: 'is set', within_last: 'within last',
  more_than_ago: 'more than … ago', between_ago: 'between … ago', before: 'before', after: 'after', any: 'any', none: 'none' };

/** Human-readable one-liner for audit logs, API and UI chips. */
export function describeRule(def: RuleDefinition): string {
  const go = (n: RuleNode): string => {
    if (n.type === 'group') {
      const inner = n.children.map(go).join(` ${n.operator} `);
      const wrapped = n.children.length > 1 ? `(${inner})` : inner;
      return n.negate ? `NOT ${wrapped}` : wrapped;
    }
    const f = getField(n.field);
    const label = f?.label ?? n.field;
    let val = '';
    const v = n.value as unknown;
    switch (n.operator) {
      case 'within_last': val = `${(v as { value: number }).value} ${(v as { unit: string }).unit}`; return wrap(`${label} within last ${val}`, n.negate);
      case 'more_than_ago': val = `${(v as { value: number }).value} ${(v as { unit: string }).unit}`; return wrap(`${label} more than ${val} ago`, n.negate);
      case 'between_ago': { const r = v as { min: number; max: number; unit: string }; return wrap(`${label} ${r.min}–${r.max} ${r.unit} ago`, n.negate); }
      case 'between': { const [a, b] = v as [number, number]; return wrap(`${label} between ${fmt(a)} and ${fmt(b)}`, n.negate); }
      case 'in': case 'not_in': return wrap(`${label} ${OP[n.operator]} [${(v as unknown[]).length} value${(v as unknown[]).length === 1 ? '' : 's'}]${window(n)}`, n.negate);
      case 'any': return wrap(`${label}: any${window(n)}`, n.negate);
      case 'none': return wrap(`${label}: none${window(n)}`, n.negate);
      case 'is_null': case 'is_not_null': return wrap(`${label} ${OP[n.operator]}`, n.negate);
      default: return wrap(`${label} ${OP[n.operator] ?? n.operator} ${fmt(v)}`, n.negate);
    }
  };
  return go(def);
}
const window = (n: { params?: { withinDays?: number; minCount?: number } }) =>
  (n.params?.withinDays ? ` in last ${n.params.withinDays}d` : '') + (n.params?.minCount ? ` ≥${n.params.minCount}×` : '');
const wrap = (s: string, negate?: boolean) => (negate ? `NOT (${s})` : s);
const fmt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-IN') : String(v));
