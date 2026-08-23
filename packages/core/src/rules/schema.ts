import { z } from 'zod';
import { FIELD_MAP, SCALAR_OPERATORS } from './fields.js';

export const TimeUnitSchema = z.enum(['minutes', 'hours', 'days', 'weeks']);
export const RelativeTimeSchema = z.object({ value: z.number().int().min(0).max(100_000), unit: TimeUnitSchema });
export const RelativeRangeSchema = z.object({ min: z.number().int().min(0), max: z.number().int().min(0), unit: TimeUnitSchema })
  .refine((r) => r.max >= r.min, 'max must be >= min');

export const ConditionParamsSchema = z.object({
  withinDays: z.number().int().min(1).max(3650).optional(),
  minCount: z.number().int().min(1).max(10_000).optional(),
  openOnly: z.boolean().optional(),
  path: z.string().regex(/^[a-zA-Z0-9_]{1,64}$/).optional(),
}).strict();

export const ConditionSchema = z.object({
  type: z.literal('condition'),
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.unknown().optional(),
  params: ConditionParamsSchema.optional(),
  negate: z.boolean().optional(),
}).superRefine((c, ctx) => {
  const f = FIELD_MAP.get(c.field);
  if (!f) { ctx.addIssue({ code: 'custom', message: `Unknown field "${c.field}"`, path: ['field'] }); return; }
  const ops = SCALAR_OPERATORS[f.type] as readonly string[];
  if (!ops.includes(c.operator)) { ctx.addIssue({ code: 'custom', message: `Operator "${c.operator}" not allowed for ${f.type} field "${c.field}"`, path: ['operator'] }); return; }
  if ((f.type === 'custom_string' || f.type === 'custom_number') && !c.params?.path) {
    ctx.addIssue({ code: 'custom', message: 'Custom attribute conditions require params.path', path: ['params', 'path'] });
  }
  const v = c.value;
  const needsValue = !['is_null', 'is_not_null', 'any', 'none'].includes(c.operator);
  if (needsValue && v === undefined) { ctx.addIssue({ code: 'custom', message: 'value is required', path: ['value'] }); return; }
  if (!needsValue) return;
  const check = (ok: boolean, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', message, path: ['value'] }); };
  switch (c.operator) {
    case 'in': case 'not_in':
      check(Array.isArray(v) && v.length > 0 && v.length <= 5000, 'value must be a non-empty array (max 5000)');
      if (Array.isArray(v) && (f.type === 'product' || f.type === 'category')) check(v.every((x) => Number.isInteger(Number(x))), 'ids must be integers');
      break;
    case 'between':
      check(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number'), 'value must be [min, max]');
      break;
    case 'within_last': case 'more_than_ago':
      check(RelativeTimeSchema.safeParse(v).success, 'value must be {value, unit}');
      break;
    case 'between_ago':
      check(RelativeRangeSchema.safeParse(v).success, 'value must be {min, max, unit}');
      break;
    case 'before': case 'after':
      check(typeof v === 'string' && !Number.isNaN(Date.parse(v)), 'value must be an ISO date');
      break;
    case 'eq': case 'neq':
      if (f.type === 'boolean') check(typeof v === 'boolean', 'value must be boolean');
      else if (f.type === 'number' || f.type === 'custom_number') check(typeof v === 'number', 'value must be a number');
      else check(typeof v === 'string' || typeof v === 'number', 'value must be a scalar');
      if (f.enumValues && typeof v === 'string') check(f.enumValues.includes(v), `value must be one of ${f.enumValues.join(', ')}`);
      break;
    case 'gt': case 'gte': case 'lt': case 'lte':
      check(typeof v === 'number', 'value must be a number');
      break;
    case 'contains': case 'starts_with':
      check(typeof v === 'string' && v.length > 0 && v.length <= 200, 'value must be a string');
      break;
  }
});

export type RuleCondition = z.infer<typeof ConditionSchema>;
export interface RuleGroup { type: 'group'; operator: 'AND' | 'OR'; negate?: boolean; children: RuleNode[] }
export type RuleNode = RuleGroup | RuleCondition;

export const RuleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.union([
    ConditionSchema,
    z.object({
      type: z.literal('group'),
      operator: z.enum(['AND', 'OR']),
      negate: z.boolean().optional(),
      children: z.array(RuleNodeSchema).min(1, 'A group needs at least one condition').max(50),
    }),
  ]),
);
export const RuleDefinitionSchema = z.object({
  type: z.literal('group'),
  operator: z.enum(['AND', 'OR']),
  negate: z.boolean().optional(),
  children: z.array(RuleNodeSchema).min(1).max(50),
}).superRefine((root, ctx) => {
  let depth = 0, count = 0;
  const walk = (n: RuleNode, d: number) => {
    depth = Math.max(depth, d);
    if (n.type === 'condition') count++;
    else n.children.forEach((c) => walk(c, d + 1));
  };
  walk(root, 1);
  if (depth > 6) ctx.addIssue({ code: 'custom', message: 'Rules may be nested at most 6 levels deep' });
  if (count > 50) ctx.addIssue({ code: 'custom', message: 'Rules may contain at most 50 conditions' });
});
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

export function parseRuleDefinition(input: unknown): RuleDefinition {
  return RuleDefinitionSchema.parse(input);
}
export function validateRuleDefinition(input: unknown): { ok: true; value: RuleDefinition } | { ok: false; issues: { path: string; message: string }[] } {
  const r = RuleDefinitionSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
}
