import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import type { DB } from '@aap/db';
import { compileRule, parseRuleDefinition, type CompiledRule, type TimeBand } from '../rules/index.js';
import { logger, sanitizeError } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { scheduleIntervalSeconds } from '../util/time.js';

export type EvalMode = 'FULL' | 'INCREMENTAL' | 'RECONCILE';
export interface EvalOptions { mode?: EvalMode; now?: Date; batchSize?: number; watermarkLagSeconds?: number }
export interface EvalResult { runId: string; mode: EvalMode; candidates: number; entered: number; exited: number; memberCount: number; durationMs: number }

/**
 * Incremental audience membership engine. Never loads members into memory; all set operations
 * are SQL. See docs/05 §4 for the correctness argument of candidate extraction.
 */
export class MembershipEngine {
  private log = logger().child({ module: 'membership' });
  constructor(private db: Kysely<DB>) {}

  async evaluate(audienceId: string, opts: EvalOptions = {}): Promise<EvalResult> {
    const started = Date.now();
    const aud = await this.db.selectFrom('audiences').selectAll().where('id', '=', audienceId).executeTakeFirst();
    if (!aud) throw new Error(`audience ${audienceId} not found`);
    const rule = await this.db.selectFrom('audience_rules').selectAll().where('audience_id', '=', audienceId).where('version', '=', aud.current_rule_version).executeTakeFirst();
    if (!rule) throw new Error(`audience ${audienceId} has no rule version ${aud.current_rule_version}`);
    const lag = opts.watermarkLagSeconds ?? 30;
    const now = opts.now ?? new Date(Date.now() - lag * 1000);
    let mode: EvalMode = opts.mode ?? 'INCREMENTAL';
    const from = aud.last_evaluated_at;
    // first run, or rule changed since the last run → full
    if (mode === 'INCREMENTAL' && (!from || aud.last_eval_mode == null || (aud as unknown as { last_eval_rule_version?: number }).last_eval_rule_version !== undefined)) { /* keep */ }
    if (mode === 'INCREMENTAL' && !from) mode = 'FULL';
    const compiled = compileRule(parseRuleDefinition(rule.definition), { now, organizationId: aud.organization_id });

    const run = await this.db.insertInto('audience_eval_runs').values({
      organization_id: aud.organization_id, audience_id: audienceId, mode, rule_version: rule.version,
      watermark_from: mode === 'INCREMENTAL' ? from : null, watermark_to: now,
    }).returning('id').executeTakeFirstOrThrow();

    try {
      let res: { candidates: number; entered: number; exited: number };
      if (mode === 'INCREMENTAL') res = await this.incremental(aud.organization_id, audienceId, rule.version, compiled, from!, now, run.id, opts.batchSize ?? 50_000);
      else res = await this.full(aud.organization_id, audienceId, rule.version, compiled, now, run.id, opts.batchSize ?? 50_000);

      const memberCount = mode === 'INCREMENTAL'
        ? Math.max(0, Number(aud.member_count) + res.entered - res.exited)
        : Number((await this.db.selectFrom('audience_members').select((eb) => eb.fn.countAll<number>().as('n')).where('audience_id', '=', audienceId).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow()).n);
      const interval = scheduleIntervalSeconds(aud.evaluation_schedule);
      await this.db.transaction().execute(async (trx) => {
        await trx.updateTable('audiences').set({
          member_count: memberCount, last_evaluated_at: now, last_eval_mode: mode,
          next_evaluation_at: interval ? new Date(now.getTime() + interval * 1000) : null,
          added_today: sql`added_today + ${res.entered}`, removed_today: sql`removed_today + ${res.exited}`, updated_at: new Date(),
        }).where('id', '=', audienceId).execute();
        await trx.insertInto('audience_stats_daily').values({ audience_id: audienceId, day: now.toISOString().slice(0, 10), member_count: memberCount, entered: res.entered, exited: res.exited })
          .onConflict((oc) => oc.columns(['audience_id', 'day']).doUpdateSet({ member_count: memberCount, entered: sql`audience_stats_daily.entered + ${res.entered}`, exited: sql`audience_stats_daily.exited + ${res.exited}` })).execute();
        await trx.updateTable('audience_eval_runs').set({ status: 'SUCCESS', candidates: res.candidates, entered: res.entered, exited: res.exited, finished_at: new Date(), duration_ms: Date.now() - started }).where('id', '=', run.id).execute();
      });
      metrics.membershipTransitions.inc({ action: 'ENTER' }, res.entered);
      metrics.membershipTransitions.inc({ action: 'EXIT' }, res.exited);
      return { runId: run.id, mode, ...res, memberCount, durationMs: Date.now() - started };
    } catch (e) {
      await this.db.updateTable('audience_eval_runs').set({ status: 'FAILED', error: sanitizeError(e), finished_at: new Date(), duration_ms: Date.now() - started }).where('id', '=', run.id).execute();
      this.log.error({ audienceId, mode, err: sanitizeError(e) }, 'evaluation failed');
      throw e;
    }
  }

  // ------------------------------------------------------------------ FULL / RECONCILE
  /** Diff-based: reads everything, writes only ENTER/EXIT differences, in keyset batches. */
  private async full(org: string, audienceId: string, version: number, compiled: CompiledRule, now: Date, runId: string, batchSize: number) {
    const range = await this.db.selectFrom('customers').select((eb) => [eb.fn.min('id').as('lo'), eb.fn.max('id').as('hi')]).where('organization_id', '=', org).executeTakeFirstOrThrow();
    let entered = 0, exited = 0, candidates = 0;
    if (range.lo == null) return { candidates, entered, exited };
    const lo0 = Number(range.lo), hi0 = Number(range.hi);
    for (let lo = lo0 - 1; lo < hi0; lo += batchSize) {
      const hi = lo + batchSize;
      candidates += batchSize;
      await this.db.transaction().execute(async (trx) => {
        entered += await this.enterPass(trx, org, audienceId, version, compiled, now, runId, sql`c.id > ${lo} AND c.id <= ${hi}`);
        exited += await this.exitPass(trx, org, audienceId, compiled, now, runId, { lo, hi });
      });
    }
    if (entered + exited > 50_000) await sql`ANALYZE audience_members`.execute(this.db); // keep planner stats fresh after big membership changes
    return { candidates: Math.min(candidates, hi0 - lo0 + 1), entered, exited };
  }

  // ------------------------------------------------------------------ INCREMENTAL
  private async incremental(org: string, audienceId: string, version: number, compiled: CompiledRule, from: Date, to: Date, runId: string, batchSize: number) {
    return this.db.transaction().execute(async (trx) => {
      await sql`CREATE TEMP TABLE aap_cand (id bigint PRIMARY KEY) ON COMMIT DROP`.execute(trx);
      const sources: RawBuilder<unknown>[] = [
        sql`SELECT c.id FROM customers c WHERE c.organization_id = ${org} AND c.updated_at > ${from} AND c.updated_at <= ${to}`,
        ...compiled.timeBands.map((b) => bandSource(org, b, from, to)),
      ];
      if (compiled.dependencies.audienceIds.length) {
        sources.push(sql`SELECT h.customer_id AS id FROM audience_membership_history h WHERE h.organization_id = ${org} AND h.audience_id = ANY(${compiled.dependencies.audienceIds}::uuid[]) AND h.occurred_at > ${from} AND h.occurred_at <= ${to}`);
      }
      const ins = await sql`INSERT INTO aap_cand (id) SELECT DISTINCT id FROM (${sql.join(sources, sql.raw(' UNION ALL '))}) s ON CONFLICT DO NOTHING`.execute(trx);
      const candidates = Number(ins.numAffectedRows ?? 0);
      let entered = 0, exited = 0;
      if (candidates > 0) {
        const r = await sql<{ lo: number; hi: number }>`SELECT min(id) AS lo, max(id) AS hi FROM aap_cand`.execute(trx);
        const lo0 = r.rows[0]!.lo, hi0 = r.rows[0]!.hi;
        for (let lo = lo0 - 1; lo < hi0; lo += batchSize) {
          const hi = lo + batchSize;
          entered += await this.enterPass(trx, org, audienceId, version, compiled, to, runId, sql`c.id > ${lo} AND c.id <= ${hi} AND EXISTS (SELECT 1 FROM aap_cand k WHERE k.id = c.id)`);
          exited += await this.exitPass(trx, org, audienceId, compiled, to, runId, { lo, hi }, sql`EXISTS (SELECT 1 FROM aap_cand k WHERE k.id = m.customer_id)`);
        }
      }
      return { candidates, entered, exited };
    });
  }

  // ------------------------------------------------------------------ passes
  /** Upserts matching customers as ACTIVE; returns number of ENTER transitions (new or re-entered). */
  private async enterPass(trx: Transaction<DB>, org: string, audienceId: string, version: number, compiled: CompiledRule, now: Date, runId: string, scope: RawBuilder<unknown>): Promise<number> {
    const r = await sql<{ n: number }>`
      WITH up AS (
        INSERT INTO audience_members (audience_id, customer_id, organization_id, status, entered_at, exited_at, last_evaluated_at, rule_version)
        SELECT ${audienceId}::uuid, c.id, c.organization_id, 'ACTIVE', ${now}::timestamptz, NULL, ${now}::timestamptz, ${version}
        FROM customers c
        WHERE c.organization_id = ${org} AND ${scope} AND NOT c.deleted AND ${compiled.predicate}
        ON CONFLICT (audience_id, customer_id) DO UPDATE
          SET status = 'ACTIVE', entered_at = ${now}::timestamptz, exited_at = NULL, last_evaluated_at = ${now}::timestamptz, rule_version = ${version}
          WHERE audience_members.status = 'EXITED'
        RETURNING customer_id
      ), hist AS (
        INSERT INTO audience_membership_history (organization_id, audience_id, customer_id, action, reason, rule_version, eval_run_id, occurred_at)
        SELECT ${org}::uuid, ${audienceId}::uuid, up.customer_id, 'ENTER', 'RULE_MATCH', ${version}, ${runId}::uuid, ${now}::timestamptz FROM up RETURNING 1
      )
      SELECT count(*)::int AS n FROM hist`.execute(trx);
    return r.rows[0]?.n ?? 0;
  }

  /**
   * Flips ACTIVE members that no longer match (or are deleted) to EXITED; returns count.
   * The id range is applied on BOTH sides of the join so the planner range-scans the customers PK
   * instead of hashing the whole table per batch (Postgres does not derive range predicates transitively).
   */
  private async exitPass(trx: Transaction<DB>, org: string, audienceId: string, compiled: CompiledRule, now: Date, runId: string, range: { lo: number; hi: number }, extra?: RawBuilder<unknown>): Promise<number> {
    const r = await sql<{ n: number }>`
      WITH gone AS MATERIALIZED (
        SELECT m.customer_id
        FROM audience_members m
        LEFT JOIN customers c ON c.id = m.customer_id AND c.id > ${range.lo} AND c.id <= ${range.hi}
        WHERE m.audience_id = ${audienceId}::uuid AND m.status = 'ACTIVE' AND m.customer_id > ${range.lo} AND m.customer_id <= ${range.hi}
          ${extra ? sql`AND ${extra}` : sql``}
          AND (c.id IS NULL OR c.deleted OR NOT coalesce((${compiled.predicate}), false))
      ), up AS (
        UPDATE audience_members m SET status = 'EXITED', exited_at = ${now}::timestamptz, last_evaluated_at = ${now}::timestamptz, is_primary = false
        FROM gone WHERE m.audience_id = ${audienceId}::uuid AND m.customer_id = gone.customer_id AND m.customer_id > ${range.lo} AND m.customer_id <= ${range.hi}
        RETURNING m.customer_id
      ), hist AS (
        INSERT INTO audience_membership_history (organization_id, audience_id, customer_id, action, reason, rule_version, eval_run_id, occurred_at)
        SELECT ${org}::uuid, ${audienceId}::uuid, up.customer_id, 'EXIT', 'RULE_NO_MATCH', NULL, ${runId}::uuid, ${now}::timestamptz FROM up RETURNING 1
      )
      SELECT count(*)::int AS n FROM hist`.execute(trx);
    return r.rows[0]?.n ?? 0;
  }

  /**
   * Priority: marks the highest-priority (lowest number) active audience as primary for every
   * customer whose memberships changed in (from, to]. Incremental by design.
   */
  async recomputePrimary(org: string, from: Date | null, to: Date): Promise<number> {
    const r = await sql<{ n: number }>`
      WITH ch AS (
        SELECT DISTINCT h.customer_id FROM audience_membership_history h
        WHERE h.organization_id = ${org} AND h.occurred_at <= ${to} ${from ? sql`AND h.occurred_at > ${from}` : sql``}
      ), ranked AS (
        SELECT m.audience_id, m.customer_id, row_number() OVER (PARTITION BY m.customer_id ORDER BY a.priority, a.created_at) AS rn
        FROM audience_members m JOIN audiences a ON a.id = m.audience_id JOIN ch ON ch.customer_id = m.customer_id
        WHERE m.status = 'ACTIVE' AND a.status = 'ACTIVE'
      ), up AS (
        UPDATE audience_members m SET is_primary = (ranked.rn = 1) FROM ranked
        WHERE m.audience_id = ranked.audience_id AND m.customer_id = ranked.customer_id AND m.is_primary IS DISTINCT FROM (ranked.rn = 1)
        RETURNING 1
      ) SELECT count(*)::int AS n FROM up`.execute(this.db);
    return r.rows[0]?.n ?? 0;
  }

  /** Audiences due for evaluation (scheduler). */
  async dueAudiences(limit = 200): Promise<Array<{ id: string; organization_id: string }>> {
    return this.db.selectFrom('audiences').select(['id', 'organization_id']).where('status', '=', 'ACTIVE')
      .where((eb) => eb.or([eb('next_evaluation_at', 'is', null), eb('next_evaluation_at', '<=', new Date())]))
      .where('evaluation_schedule', '<>', 'MANUAL').orderBy('next_evaluation_at').limit(limit).execute();
  }
}

function bandSource(org: string, b: TimeBand, from: Date, to: Date): RawBuilder<unknown> {
  const lo = sql`${from}::timestamptz - make_interval(secs => ${b.offsetSeconds})`;
  const hi = sql`${to}::timestamptz - make_interval(secs => ${b.offsetSeconds})`;
  const col = sql.raw(b.column);
  switch (b.table) {
    case 'customers':
      return sql`SELECT c.id FROM customers c WHERE c.organization_id = ${org} AND c.${col} > ${lo} AND c.${col} <= ${hi}`;
    case 'customer_product_purchases': case 'customer_category_purchases': case 'customer_product_interactions': {
      const filter = b.filter ? sql`AND p.${sql.raw(b.filter.column)} = ANY(${b.filter.values.map(Number)}::bigint[])` : sql``;
      return sql`SELECT p.customer_id AS id FROM ${sql.raw(b.table)} p WHERE p.organization_id = ${org} ${filter} AND p.${col} > ${lo} AND p.${col} <= ${hi}`;
    }
  }
}
