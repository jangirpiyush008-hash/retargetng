import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from '@aap/db';
import { compileRule, parseRuleDefinition, RuleDefinitionSchema, describeRule, type RuleDefinition } from '../rules/index.js';
import { compilePolicyReasonExpr, parsePolicy, type CompliancePolicyRules } from '../consent/policy.js';
import { TEMPLATE_MAP } from './templates.js';
import { AuditLogger } from '../audit/index.js';
import { assertCan, type Principal } from '../rbac/index.js';
import { NotFoundError, ValidationError, ConflictError, slugify, pct } from '../util/index.js';
import type { JobQueue } from '../queue/types.js';
import { QUEUES } from '../queue/index.js';

export const ScheduleSchema = z.enum(['REALTIME', 'HOURLY', 'EVERY_6_HOURS', 'DAILY', 'MANUAL']);
export const DistributionPolicySchema = z.object({
  primaryOnly: z.boolean().default(false),
  identifierKinds: z.array(z.enum(['EMAIL', 'PHONE'])).min(1).default(['EMAIL', 'PHONE']),
}).default({});
export const CreateAudienceSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().regex(/^[A-Z0-9_]{2,64}$/).optional(),
  description: z.string().max(2000).default(''),
  definition: RuleDefinitionSchema.optional(),
  templateKey: z.string().optional(),
  templateParams: z.record(z.unknown()).default({}),
  evaluationSchedule: ScheduleSchema.default('HOURLY'),
  priority: z.number().int().min(1).max(10_000).default(100),
  excludeAudienceIds: z.array(z.string().uuid()).default([]),
  holdoutPercent: z.number().min(0).max(50).default(0),
  tags: z.array(z.string().max(40)).max(20).default([]),
  distributionPolicy: DistributionPolicySchema,
  status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
}).refine((v) => v.definition || v.templateKey, 'definition or templateKey is required');
export type CreateAudienceInput = z.infer<typeof CreateAudienceSchema>;
export const UpdateAudienceSchema = CreateAudienceSchema.innerType().partial().extend({ status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional() });
export type UpdateAudienceInput = z.infer<typeof UpdateAudienceSchema>;

export interface PreviewFunnel {
  total: number;              // rule matches (source)
  excludedByAudience: number;
  suppressed: number;
  deleted: number;
  consentDenied: number;
  consentUnknown: number;
  consentExpired: number;
  missingFlag: number;
  blockedCountry: number;
  noIdentifier: number;
  invalidIdentifier: number;
  customerStatus: number;
  eligible: number;           // after exclusions + policy
  duplicates: number;         // eligible rows sharing an identifier
  holdout: number;
  estimatedActivation: number;
  estimated: boolean;         // true if sampled
  sql: string;
  description: string;
  history?: Array<{ day: string; member_count: number; entered: number; exited: number }>;
}

export class AudienceService {
  private audit: AuditLogger;
  constructor(private db: Kysely<DB>, private queue: JobQueue) { this.audit = new AuditLogger(db); }

  resolveDefinition(input: { definition?: RuleDefinition; templateKey?: string; templateParams?: Record<string, unknown> }): RuleDefinition {
    if (input.definition) return parseRuleDefinition(input.definition);
    const t = TEMPLATE_MAP.get(input.templateKey ?? '');
    if (!t) throw new ValidationError(`Unknown template ${input.templateKey}`);
    for (const p of t.params) if (p.required && (input.templateParams?.[p.key] == null || (Array.isArray(input.templateParams[p.key]) && !(input.templateParams[p.key] as unknown[]).length)))
      throw new ValidationError(`Template parameter "${p.key}" is required`);
    return parseRuleDefinition(t.build(input.templateParams ?? {}));
  }

  async create(principal: Principal, raw: unknown): Promise<{ id: string }> {
    assertCan(principal, 'audiences:write');
    const input = CreateAudienceSchema.parse(raw);
    const org = principal.organizationId;
    const definition = this.resolveDefinition(input);
    const compiled = compileRule(definition, { now: new Date(), organizationId: org });
    const template = input.templateKey ? TEMPLATE_MAP.get(input.templateKey) : undefined;
    const slug = input.slug ?? slugify(input.name);
    const exists = await this.db.selectFrom('audiences').select('id').where('organization_id', '=', org).where('slug', '=', slug).executeTakeFirst();
    if (exists) throw new ConflictError(`An audience with slug ${slug} already exists`);
    if (input.excludeAudienceIds.length) await this.assertAudiencesExist(org, input.excludeAudienceIds);
    const id = await this.db.transaction().execute(async (trx) => {
      const a = await trx.insertInto('audiences').values({
        organization_id: org, name: input.name, slug, description: input.description, status: input.status, current_rule_version: 1,
        evaluation_schedule: input.evaluationSchedule, priority: input.priority, template_key: input.templateKey ?? null, tags: input.tags,
        holdout_percent: input.holdoutPercent, distribution_policy: JSON.stringify(input.distributionPolicy),
        recommendation: template ? JSON.stringify(template.recommendation) : null, created_by: principal.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('audience_rules').values({ audience_id: a.id, version: 1, definition: JSON.stringify(definition), compiled_sql: compiled.predicate.compile(trx).sql, created_by: principal.id }).execute();
      if (input.excludeAudienceIds.length) await trx.insertInto('audience_exclusions').values(input.excludeAudienceIds.map((x) => ({ audience_id: a.id, excluded_audience_id: x }))).execute();
      await this.audit.log({ organizationId: org, actor: principal, action: 'AUDIENCE_CREATED', entityType: 'audience', entityId: a.id, after: { name: input.name, slug, rule: describeRule(definition), status: input.status } }, trx);
      return a.id;
    });
    if (input.status === 'ACTIVE') await this.enqueueEvaluation(org, id, 'FULL');
    return { id };
  }

  async update(principal: Principal, id: string, raw: unknown): Promise<void> {
    assertCan(principal, 'audiences:write');
    const input = UpdateAudienceSchema.parse(raw);
    const org = principal.organizationId;
    const aud = await this.getOrThrow(org, id);
    let newDefinition: RuleDefinition | undefined;
    if (input.definition || input.templateKey) newDefinition = this.resolveDefinition({ definition: input.definition, templateKey: input.templateKey ?? aud.template_key ?? undefined, templateParams: input.templateParams });
    if (input.excludeAudienceIds?.some((x) => x === id)) throw new ValidationError('An audience cannot exclude itself');
    if (input.excludeAudienceIds?.length) await this.assertAudiencesExist(org, input.excludeAudienceIds);
    if (input.status === 'ARCHIVED') assertCan(principal, 'audiences:delete');
    const wasActive = aud.status === 'ACTIVE';
    await this.db.transaction().execute(async (trx) => {
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (input.name) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.evaluationSchedule) patch.evaluation_schedule = input.evaluationSchedule;
      if (input.priority) patch.priority = input.priority;
      if (input.holdoutPercent !== undefined) patch.holdout_percent = input.holdoutPercent;
      if (input.tags) patch.tags = input.tags;
      if (input.distributionPolicy) patch.distribution_policy = JSON.stringify(input.distributionPolicy);
      if (input.status) { patch.status = input.status; if (input.status === 'ARCHIVED') patch.archived_at = new Date(); }
      if (newDefinition) {
        const v = aud.current_rule_version + 1;
        const compiled = compileRule(newDefinition, { now: new Date(), organizationId: org });
        await trx.insertInto('audience_rules').values({ audience_id: id, version: v, definition: JSON.stringify(newDefinition), compiled_sql: compiled.predicate.compile(trx).sql, created_by: principal.id }).execute();
        patch.current_rule_version = v;
        if (input.templateKey) patch.template_key = input.templateKey;
      }
      await trx.updateTable('audiences').set(patch).where('id', '=', id).execute();
      if (input.excludeAudienceIds) {
        await trx.deleteFrom('audience_exclusions').where('audience_id', '=', id).execute();
        if (input.excludeAudienceIds.length) await trx.insertInto('audience_exclusions').values(input.excludeAudienceIds.map((x) => ({ audience_id: id, excluded_audience_id: x }))).execute();
      }
      await this.audit.log({ organizationId: org, actor: principal, action: input.status === 'ARCHIVED' ? 'AUDIENCE_ARCHIVED' : 'AUDIENCE_UPDATED', entityType: 'audience', entityId: id,
        before: { name: aud.name, status: aud.status, rule_version: aud.current_rule_version }, after: { ...input, definition: newDefinition ? describeRule(newDefinition) : undefined } }, trx);
    });
    const nowActive = (input.status ?? aud.status) === 'ACTIVE';
    if (nowActive && (newDefinition || !wasActive)) await this.enqueueEvaluation(org, id, 'FULL');
    if (input.status === 'ARCHIVED' || input.status === 'PAUSED') {
      // distribution engine pauses/deletes destination audiences via the sync queue
      await this.queue.enqueue({ queue: QUEUES.sync, name: 'audience-status-changed', payload: { organizationId: org, audienceId: id, status: input.status }, priority: 20 });
    }
  }

  async enqueueEvaluation(org: string, audienceId: string, mode: 'FULL' | 'INCREMENTAL' | 'RECONCILE' = 'INCREMENTAL'): Promise<void> {
    await this.queue.enqueue({ queue: QUEUES.evaluate, name: 'evaluate-audience', payload: { organizationId: org, audienceId, mode }, idempotencyKey: `eval:${audienceId}:${mode}`, priority: mode === 'FULL' ? 30 : 80 });
  }

  async getOrThrow(org: string, id: string) {
    const a = await this.db.selectFrom('audiences').selectAll().where('organization_id', '=', org).where('id', '=', id).executeTakeFirst();
    if (!a) throw new NotFoundError('Audience not found');
    return a;
  }

  private async assertAudiencesExist(org: string, ids: string[]) {
    const rows = await this.db.selectFrom('audiences').select('id').where('organization_id', '=', org).where('id', 'in', ids).execute();
    if (rows.length !== new Set(ids).size) throw new ValidationError('One or more excluded audiences do not exist');
  }

  /** Effective compliance policy for an org (+ optional destination type). */
  async resolvePolicy(org: string, destinationType?: string | null, policyId?: string | null): Promise<CompliancePolicyRules> {
    let row = policyId ? await this.db.selectFrom('compliance_policies').select('rules').where('id', '=', policyId).where('organization_id', '=', org).executeTakeFirst() : undefined;
    if (!row && destinationType) row = await this.db.selectFrom('compliance_policies').select('rules').where('organization_id', '=', org).where('destination_type', '=', destinationType).orderBy('is_default', 'desc').executeTakeFirst();
    if (!row) row = await this.db.selectFrom('compliance_policies').select('rules').where('organization_id', '=', org).where('destination_type', 'is', null).orderBy('is_default', 'desc').executeTakeFirst();
    return parsePolicy(row?.rules ?? {});
  }

  /**
   * Preview funnel for a rule definition (saved or unsaved). Exact when it completes within the
   * statement timeout; otherwise a 2% block sample is extrapolated and `estimated=true`.
   */
  async preview(org: string, input: { definition?: RuleDefinition; templateKey?: string; templateParams?: Record<string, unknown>; excludeAudienceIds?: string[]; audienceId?: string; destinationType?: string | null; holdoutPercent?: number; timeoutMs?: number }): Promise<PreviewFunnel> {
    const definition = this.resolveDefinition(input);
    const now = new Date();
    const compiled = compileRule(definition, { now, organizationId: org });
    const policy = await this.resolvePolicy(org, input.destinationType);
    const reason = compilePolicyReasonExpr(policy, now);
    let excludeIds = input.excludeAudienceIds ?? [];
    let holdout = input.holdoutPercent ?? 0;
    if (input.audienceId) {
      const ex = await this.db.selectFrom('audience_exclusions').select('excluded_audience_id').where('audience_id', '=', input.audienceId).execute();
      excludeIds = [...new Set([...excludeIds, ...ex.map((e) => e.excluded_audience_id)])];
      if (input.holdoutPercent === undefined) { const a = await this.db.selectFrom('audiences').select('holdout_percent').where('id', '=', input.audienceId).executeTakeFirst(); holdout = Number(a?.holdout_percent ?? 0); }
    }
    const excluded = excludeIds.length ? sql`EXISTS (SELECT 1 FROM audience_members x WHERE x.customer_id = c.id AND x.status = 'ACTIVE' AND x.audience_id = ANY(${excludeIds}::uuid[]))` : sql`false`;
    const query = (sample: boolean) => sql<Record<string, number>>`
      WITH m AS (
        SELECT c.id, coalesce(c.email_hash, c.phone_hash) AS idh, ${reason} AS reason, ${excluded} AS excluded
        FROM customers c ${sample ? sql`TABLESAMPLE SYSTEM (2)` : sql``}
        WHERE c.organization_id = ${org} AND ${compiled.predicate}
      )
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE excluded)::int AS excluded_by_audience,
        count(*) FILTER (WHERE NOT excluded AND reason = 'SUPPRESSED')::int AS suppressed,
        count(*) FILTER (WHERE NOT excluded AND reason = 'DELETED')::int AS deleted,
        count(*) FILTER (WHERE NOT excluded AND reason = 'CONSENT_DENIED')::int AS consent_denied,
        count(*) FILTER (WHERE NOT excluded AND reason = 'CONSENT_UNKNOWN')::int AS consent_unknown,
        count(*) FILTER (WHERE NOT excluded AND reason = 'CONSENT_EXPIRED')::int AS consent_expired,
        count(*) FILTER (WHERE NOT excluded AND reason = 'MISSING_FLAG')::int AS missing_flag,
        count(*) FILTER (WHERE NOT excluded AND reason = 'BLOCKED_COUNTRY')::int AS blocked_country,
        count(*) FILTER (WHERE NOT excluded AND reason = 'NO_IDENTIFIER')::int AS no_identifier,
        count(*) FILTER (WHERE NOT excluded AND reason = 'INVALID_IDENTIFIER')::int AS invalid_identifier,
        count(*) FILTER (WHERE NOT excluded AND reason = 'CUSTOMER_STATUS')::int AS customer_status,
        count(*) FILTER (WHERE NOT excluded AND reason IS NULL)::int AS eligible,
        count(DISTINCT idh) FILTER (WHERE NOT excluded AND reason IS NULL)::int AS distinct_ids
      FROM m`;
    let row: Record<string, number>; let estimated = false;
    try {
      row = await this.withTimeout(input.timeoutMs ?? 20_000, (trx) => query(false).execute(trx).then((r) => r.rows[0]!));
    } catch (e) {
      if (!/statement timeout|canceling statement/i.test(String((e as Error).message))) throw e;
      const s = await this.withTimeout(input.timeoutMs ?? 20_000, (trx) => query(true).execute(trx).then((r) => r.rows[0]!));
      row = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.round(Number(v) * 50)]));
      estimated = true;
    }
    const eligible = Number(row.eligible);
    const duplicates = Math.max(0, eligible - Number(row.distinct_ids));
    const holdoutN = Math.round((eligible - duplicates) * holdout / 100);
    const history = input.audienceId ? await this.db.selectFrom('audience_stats_daily').select(['day', 'member_count', 'entered', 'exited']).where('audience_id', '=', input.audienceId).orderBy('day', 'desc').limit(30).execute() : undefined;
    return {
      total: Number(row.total), excludedByAudience: Number(row.excluded_by_audience), suppressed: Number(row.suppressed), deleted: Number(row.deleted),
      consentDenied: Number(row.consent_denied), consentUnknown: Number(row.consent_unknown), consentExpired: Number(row.consent_expired), missingFlag: Number(row.missing_flag),
      blockedCountry: Number(row.blocked_country), noIdentifier: Number(row.no_identifier), invalidIdentifier: Number(row.invalid_identifier), customerStatus: Number(row.customer_status),
      eligible, duplicates, holdout: holdoutN, estimatedActivation: Math.max(0, eligible - duplicates - holdoutN), estimated,
      sql: compiled.predicate.compile(this.db).sql, description: describeRule(definition),
      history: history?.map((h) => ({ day: String(h.day), member_count: Number(h.member_count), entered: Number(h.entered), exited: Number(h.exited) })).reverse(),
    };
  }

  private async withTimeout<T>(ms: number, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = ${sql.lit(Math.max(1000, Math.floor(ms)))}`.execute(trx);
      return fn(trx as unknown as Kysely<DB>);
    });
  }

  /** Summary used by list/detail pages (cached counters only — no big scans). */
  async summarize(org: string, ids?: string[]) {
    let q = this.db.selectFrom('audiences as a').leftJoin('audience_destinations as ad', 'ad.audience_id', 'a.id')
      .select(['a.id', 'a.name', 'a.slug', 'a.description', 'a.status', 'a.priority', 'a.evaluation_schedule', 'a.member_count', 'a.eligible_count', 'a.added_today', 'a.removed_today', 'a.last_evaluated_at', 'a.next_evaluation_at', 'a.template_key', 'a.tags', 'a.holdout_percent', 'a.created_at', 'a.updated_at', 'a.current_rule_version'])
      .select((eb) => [
        eb.fn.count<number>('ad.id').as('destination_count'),
        sql<number>`count(*) FILTER (WHERE ad.status = 'ERROR')`.as('destination_errors'),
        sql<number>`max(ad.last_synced_at)`.as('last_synced_at'),
        sql<number>`min(ad.next_sync_at)`.as('next_sync_at'),
        sql<number>`sum(ad.submitted_count)`.as('submitted_count'),
        sql<number>`sum(ad.matched_count)`.as('matched_count'),
      ])
      .where('a.organization_id', '=', org).where('a.status', '<>', 'ARCHIVED').groupBy('a.id').orderBy('a.priority').orderBy('a.name');
    if (ids) q = q.where('a.id', 'in', ids);
    const rows = await q.execute();
    return rows.map((r) => ({ ...r, match_rate: pct(Number(r.matched_count ?? 0), Number(r.submitted_count ?? 0)) }));
  }
}
