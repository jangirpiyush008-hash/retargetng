import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB } from '@aap/db';
import { compilePolicyReasonExpr, type CompliancePolicyRules } from '../consent/policy.js';
import { DestinationRegistry } from '../destinations/registry.js';
import { DestinationError, type DestinationAdapter, type DestinationContext, type MemberRecord } from '../destinations/types.js';
import type { SecretStore } from '../secrets/index.js';
import { AudienceService, DistributionPolicySchema } from '../audience/service.js';
import { AuditLogger, SYSTEM_ACTOR } from '../audit/index.js';
import { assertCan, type Principal } from '../rbac/index.js';
import { logger, sanitizeError } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { NotFoundError, ValidationError, pct, scheduleIntervalSeconds, sleep } from '../util/index.js';
import type { JobQueue } from '../queue/types.js';
import { QUEUES } from '../queue/index.js';

export type SyncTrigger = 'SCHEDULED' | 'MANUAL' | 'EVENT' | 'INITIAL' | 'SUPPRESSION' | 'RETRY';
export type SyncMode = 'INCREMENTAL' | 'FULL' | 'DRY_RUN' | 'REMOVE_ALL';

export interface SyncJobResult {
  jobId: string; status: string; sourceCount: number; eligibleCount: number; added: number; removed: number; skipped: number; failed: number; batchesTotal: number;
  funnel: Record<string, number>;
}

export interface DistributionDeps { db: Kysely<DB>; queue: JobQueue; secrets: SecretStore; registry?: DestinationRegistry; fetchImpl?: typeof fetch }

/**
 * Audience Distribution Engine: audience → eligibility (policy, exclusions, suppression, holdout)
 * → delta vs. destination state → batched, checkpointed, retried delivery via DestinationAdapter.
 */
export class DistributionEngine {
  private log = logger().child({ module: 'distribution' });
  private registry: DestinationRegistry;
  private audit: AuditLogger;
  private audiences: AudienceService;
  constructor(private deps: DistributionDeps) {
    this.registry = deps.registry ?? new DestinationRegistry();
    this.audit = new AuditLogger(deps.db);
    this.audiences = new AudienceService(deps.db, deps.queue);
  }
  get db() { return this.deps.db; }

  // ------------------------------------------------------------------ activation
  /** Activate an audience on one or more destination accounts (creates audience_destinations + initial sync jobs). */
  async activate(principal: Principal, audienceId: string, input: { destinationAccountIds: string[]; syncMode?: 'INCREMENTAL' | 'FULL_REFRESH'; syncSchedule?: string | null; compliancePolicyId?: string | null; dryRun?: boolean }) {
    assertCan(principal, 'audiences:activate');
    const org = principal.organizationId;
    const aud = await this.audiences.getOrThrow(org, audienceId);
    if (!input.destinationAccountIds.length) throw new ValidationError('Select at least one destination account');
    const accounts = await this.db.selectFrom('destination_accounts as da').innerJoin('destinations as d', 'd.id', 'da.destination_id')
      .select(['da.id', 'da.external_account_id', 'da.name', 'd.type', 'd.status as destination_status', 'd.id as destination_id'])
      .where('da.organization_id', '=', org).where('da.id', 'in', input.destinationAccountIds).execute();
    if (accounts.length !== new Set(input.destinationAccountIds).size) throw new NotFoundError('One or more destination accounts not found');
    if (input.dryRun) {
      const reports = [];
      for (const a of accounts) {
        const f = await this.audiences.preview(org, { audienceId, destinationType: a.type, ...(await this.ruleFor(audienceId)) });
        const adapter = this.registry.get(a.type);
        reports.push({ destinationAccountId: a.id, destinationType: a.type, accountName: a.name, funnel: f, estimatedPayload: { records: f.estimatedActivation, batches: Math.ceil(f.estimatedActivation / adapter.capabilities.maxBatchSize), maxBatchSize: adapter.capabilities.maxBatchSize, identifierProfiles: adapter.capabilities.hashProfiles } });
      }
      await this.audit.log({ organizationId: org, actor: principal, action: 'AUDIENCE_DRY_RUN', entityType: 'audience', entityId: audienceId, metadata: { destinations: accounts.map((a) => a.type) } });
      return { dryRun: true, reports };
    }
    const created: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      for (const a of accounts) {
        if (a.destination_status !== 'CONNECTED') throw new ValidationError(`Destination ${a.name} is not connected`);
        const existing = await trx.selectFrom('audience_destinations').select(['id', 'status']).where('audience_id', '=', audienceId).where('destination_account_id', '=', a.id).executeTakeFirst();
        if (existing) {
          if (existing.status === 'PAUSED' || existing.status === 'ERROR') await trx.updateTable('audience_destinations').set({ status: existing.status === 'ERROR' ? 'ACTIVE' : 'ACTIVE', updated_at: new Date(), last_error: null }).where('id', '=', existing.id).execute();
          created.push(existing.id); continue;
        }
        const ad = await trx.insertInto('audience_destinations').values({
          organization_id: org, audience_id: audienceId, destination_account_id: a.id, status: 'PENDING_CREATE',
          sync_mode: input.syncMode ?? 'INCREMENTAL', sync_schedule: (input.syncSchedule as never) ?? null, compliance_policy_id: input.compliancePolicyId ?? null,
          external_audience_name: `${aud.name} [AAP ${aud.slug}]`, created_by: principal.id,
        }).returning('id').executeTakeFirstOrThrow();
        created.push(ad.id);
      }
      if (aud.status !== 'ACTIVE') await trx.updateTable('audiences').set({ status: 'ACTIVE', updated_at: new Date() }).where('id', '=', audienceId).execute();
      await this.audit.log({ organizationId: org, actor: principal, action: 'AUDIENCE_ACTIVATED', entityType: 'audience', entityId: audienceId, after: { destinations: accounts.map((a) => ({ type: a.type, account: a.name })), syncMode: input.syncMode ?? 'INCREMENTAL' } }, trx);
    });
    if (aud.status !== 'ACTIVE' || !aud.last_evaluated_at) await this.audiences.enqueueEvaluation(org, audienceId, 'FULL');
    for (const adId of created) await this.enqueueSync(org, adId, 'INITIAL', 'INCREMENTAL', principal.id);
    return { dryRun: false, audienceDestinationIds: created };
  }

  private async ruleFor(audienceId: string) {
    const a = await this.db.selectFrom('audiences').select(['current_rule_version']).where('id', '=', audienceId).executeTakeFirstOrThrow();
    const r = await this.db.selectFrom('audience_rules').select('definition').where('audience_id', '=', audienceId).where('version', '=', a.current_rule_version).executeTakeFirstOrThrow();
    return { definition: r.definition as never };
  }

  async enqueueSync(org: string, audienceDestinationId: string, trigger: SyncTrigger, mode: SyncMode = 'INCREMENTAL', createdBy: string | null = null, idempotencyKey?: string) {
    return this.deps.queue.enqueue({ queue: QUEUES.sync, name: 'sync-audience-destination', payload: { organizationId: org, audienceDestinationId, trigger, mode, createdBy }, idempotencyKey: idempotencyKey ?? `sync:${audienceDestinationId}:${mode}`, priority: trigger === 'SUPPRESSION' ? 10 : trigger === 'MANUAL' || trigger === 'INITIAL' ? 30 : 70, maxAttempts: 8 });
  }

  async pause(principal: Principal, audienceId: string, audienceDestinationId?: string) {
    assertCan(principal, 'audiences:activate');
    let q = this.db.updateTable('audience_destinations').set({ status: 'PAUSED', updated_at: new Date() }).where('organization_id', '=', principal.organizationId).where('audience_id', '=', audienceId).where('status', 'in', ['ACTIVE', 'ERROR', 'PENDING_CREATE']);
    if (audienceDestinationId) q = q.where('id', '=', audienceDestinationId);
    await q.execute();
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'AUDIENCE_SYNC_PAUSED', entityType: 'audience', entityId: audienceId, metadata: { audienceDestinationId } });
  }
  async resume(principal: Principal, audienceId: string, audienceDestinationId?: string) {
    assertCan(principal, 'audiences:activate');
    let q = this.db.updateTable('audience_destinations').set({ status: 'ACTIVE', updated_at: new Date(), last_error: null }).where('organization_id', '=', principal.organizationId).where('audience_id', '=', audienceId).where('status', 'in', ['PAUSED', 'ERROR']).returning('id');
    if (audienceDestinationId) q = q.where('id', '=', audienceDestinationId);
    const rows = await q.execute();
    for (const r of rows) await this.enqueueSync(principal.organizationId, r.id, 'MANUAL', 'INCREMENTAL', principal.id);
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'AUDIENCE_SYNC_RESUMED', entityType: 'audience', entityId: audienceId });
  }
  async syncNow(principal: Principal, audienceId: string, opts: { audienceDestinationId?: string; mode?: SyncMode } = {}) {
    assertCan(principal, 'audiences:activate');
    let q = this.db.selectFrom('audience_destinations').select('id').where('organization_id', '=', principal.organizationId).where('audience_id', '=', audienceId).where('status', 'in', ['ACTIVE', 'PENDING_CREATE', 'ERROR']);
    if (opts.audienceDestinationId) q = q.where('id', '=', opts.audienceDestinationId);
    const rows = await q.execute();
    const jobs = [];
    for (const r of rows) jobs.push(await this.enqueueSync(principal.organizationId, r.id, 'MANUAL', opts.mode ?? 'INCREMENTAL', principal.id, `sync:${r.id}:manual:${Date.now()}`));
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'AUDIENCE_SYNC_REQUESTED', entityType: 'audience', entityId: audienceId, metadata: { count: rows.length, mode: opts.mode ?? 'INCREMENTAL' } });
    return { enqueued: rows.length };
  }
  /** Remove the audience from a destination (REMOVE_ALL then delete remote audience). */
  async deactivate(principal: Principal, audienceId: string, audienceDestinationId: string) {
    assertCan(principal, 'audiences:delete');
    await this.db.updateTable('audience_destinations').set({ status: 'DELETING', updated_at: new Date() }).where('id', '=', audienceDestinationId).where('organization_id', '=', principal.organizationId).execute();
    await this.enqueueSync(principal.organizationId, audienceDestinationId, 'MANUAL', 'REMOVE_ALL', principal.id, `sync:${audienceDestinationId}:remove_all:${Date.now()}`);
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'AUDIENCE_DESTINATION_DELETED', entityType: 'audience', entityId: audienceId, metadata: { audienceDestinationId } });
  }

  /** Handles audience status transitions coming from AudienceService (PAUSED/ARCHIVED). */
  async onAudienceStatusChanged(org: string, audienceId: string, status: string) {
    const ads = await this.db.selectFrom('audience_destinations').select(['id', 'status']).where('organization_id', '=', org).where('audience_id', '=', audienceId).execute();
    for (const ad of ads) {
      if (status === 'PAUSED' && ['ACTIVE', 'PENDING_CREATE', 'ERROR'].includes(ad.status)) await this.db.updateTable('audience_destinations').set({ status: 'PAUSED', updated_at: new Date() }).where('id', '=', ad.id).execute();
      if (status === 'ARCHIVED' && ad.status !== 'DELETED') { await this.db.updateTable('audience_destinations').set({ status: 'DELETING', updated_at: new Date() }).where('id', '=', ad.id).execute(); await this.enqueueSync(org, ad.id, 'MANUAL', 'REMOVE_ALL', null, `sync:${ad.id}:remove_all:${Date.now()}`); }
    }
  }

  /** Suppression sweep: customers suppressed/deleted since `since` → sync every destination audience they are in. */
  async sweepSuppressed(org: string, since: Date | null): Promise<number> {
    const rows = await sql<{ id: string }>`
      SELECT DISTINCT adm.audience_destination_id AS id
      FROM customers c JOIN audience_destination_members adm ON adm.customer_id = c.id
      JOIN audience_destinations ad ON ad.id = adm.audience_destination_id
      WHERE c.organization_id = ${org} AND (c.suppressed OR c.deleted) AND adm.state = 'SYNCED' AND ad.status = 'ACTIVE'
        ${since ? sql`AND (c.suppressed_at > ${since} OR c.deleted_at > ${since})` : sql``}`.execute(this.db);
    for (const r of rows.rows) await this.enqueueSync(org, r.id, 'SUPPRESSION', 'INCREMENTAL', null, `sync:${r.id}:suppression`);
    return rows.rows.length;
  }

  /** Destination audiences due for a scheduled sync. */
  async dueSyncs(limit = 200) {
    return this.db.selectFrom('audience_destinations as ad').innerJoin('audiences as a', 'a.id', 'ad.audience_id')
      .select(['ad.id', 'ad.organization_id']).where('ad.status', '=', 'ACTIVE').where('a.status', '=', 'ACTIVE')
      .where((eb) => eb.or([eb('ad.next_sync_at', 'is', null), eb('ad.next_sync_at', '<=', new Date())]))
      .where(sql<boolean>`coalesce(ad.sync_schedule, a.evaluation_schedule) <> 'MANUAL'`).orderBy('ad.next_sync_at').limit(limit).execute();
  }

  // ------------------------------------------------------------------ sync job
  /**
   * Run (or resume) a sync for one audience_destination. Idempotent and checkpointed: a crash
   * mid-way leaves PENDING/SENT batches which are re-processed by calling run() again.
   */
  async runSync(input: { organizationId: string; audienceDestinationId: string; trigger: SyncTrigger; mode?: SyncMode; createdBy?: string | null; resumeJobId?: string; now?: Date }): Promise<SyncJobResult> {
    const { organizationId: org, audienceDestinationId: adId } = input;
    const mode: SyncMode = input.mode ?? 'INCREMENTAL';
    const now = input.now ?? new Date();
    const ctx = await this.loadContext(org, adId);
    if (!ctx) throw new NotFoundError('audience destination not found');
    const { ad, account, destination, audience, adapter } = ctx;
    if (['DELETED'].includes(ad.status)) throw new Error('audience destination already deleted');
    if (ad.status === 'PAUSED' && mode !== 'REMOVE_ALL') { this.log.info({ adId }, 'sync skipped: paused'); return this.emptyResult('SKIPPED_PAUSED'); }
    if (destination.status !== 'CONNECTED') { await this.flagError(adId, `destination ${destination.status}`); throw new Error(`destination ${destination.id} is ${destination.status}`); }
    const dctx = this.adapterContext(destination, mode === 'DRY_RUN');

    // 1. ensure remote audience exists
    let externalAudienceId = ad.external_audience_id;
    if (!externalAudienceId && mode !== 'DRY_RUN') {
      try {
        const created = await adapter.createAudience(dctx, { name: ad.external_audience_name ?? audience.name, description: audience.description || `Audience ${audience.slug} managed by Audience Activation Platform`, externalAccountId: account.external_account_id });
        externalAudienceId = created.externalAudienceId;
        await this.db.updateTable('audience_destinations').set({ external_audience_id: externalAudienceId, status: 'ACTIVE', updated_at: new Date() }).where('id', '=', adId).execute();
        await this.audit.log({ organizationId: org, actor: SYSTEM_ACTOR, action: 'DESTINATION_AUDIENCE_CREATED', entityType: 'audience_destination', entityId: adId, after: { externalAudienceId, destination: destination.type } });
      } catch (e) { await this.handleFatal(adId, e); throw e; }
    } else if (ad.status === 'PENDING_CREATE' && mode !== 'DRY_RUN') {
      await this.db.updateTable('audience_destinations').set({ status: 'ACTIVE' }).where('id', '=', adId).execute();
    }

    // 2. create or resume the job
    let job = input.resumeJobId ? await this.db.selectFrom('sync_jobs').selectAll().where('id', '=', input.resumeJobId).executeTakeFirst() : undefined;
    if (!job) {
      job = await this.db.insertInto('sync_jobs').values({
        organization_id: org, audience_id: ad.audience_id, audience_destination_id: adId, destination_account_id: account.id, trigger: input.trigger, mode, status: 'RUNNING', started_at: now, created_by: input.createdBy ?? null,
        idempotency_key: `job:${adId}:${randomUUID()}`,
      }).returningAll().executeTakeFirstOrThrow();
      if (mode !== 'DRY_RUN') await this.db.updateTable('audience_destinations').set({ last_sync_job_id: job.id }).where('id', '=', adId).execute();
      // 3. eligibility + delta + batches (single transaction = checkpoint)
      const policy = await this.audiences.resolvePolicy(org, destination.type, ad.compliance_policy_id);
      await this.computeDelta(job.id, ctx, policy, mode, now);
      job = await this.db.selectFrom('sync_jobs').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
    } else {
      await this.db.updateTable('sync_jobs').set({ status: 'RUNNING' }).where('id', '=', job.id).execute();
    }

    // 4. deliver batches
    const outcome = await this.deliverBatches(job.id, ctx, dctx, externalAudienceId, mode);

    // 5. status + counters
    const final = await this.db.selectFrom('sync_jobs').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
    let status: string;
    if (outcome.fatal) status = 'PAUSED';
    else if (outcome.cancelled) status = 'CANCELLED';
    else if (final.batches_total > 0 && outcome.succeeded === 0 && outcome.failedBatches > 0) status = 'FAILED';
    else if (outcome.failedBatches > 0 || Number(final.skipped) > 0 || Number(final.failed) > 0) status = 'SUCCESS_WITH_WARNINGS';
    else status = 'SUCCESS';
    await this.db.updateTable('sync_jobs').set({ status, finished_at: status === 'PAUSED' ? null : new Date() }).where('id', '=', job.id).execute();

    if (mode !== 'DRY_RUN' && !outcome.fatal) {
      await this.refreshCounters(adId, ctx, dctx, externalAudienceId, now);
      if (mode === 'REMOVE_ALL') {
        try { if (externalAudienceId) await adapter.deleteAudience(dctx, { externalAudienceId, externalAccountId: account.external_account_id }); } catch (e) { this.log.warn({ adId, err: sanitizeError(e) }, 'remote delete failed'); }
        await this.db.updateTable('audience_destinations').set({ status: 'DELETED', updated_at: new Date() }).where('id', '=', adId).execute();
      }
    }
    metrics.syncMembers.inc({ op: 'ADD', result: 'ok' }, Number(final.added));
    metrics.syncMembers.inc({ op: 'REMOVE', result: 'ok' }, Number(final.removed));
    return { jobId: job.id, status, sourceCount: Number(final.source_count), eligibleCount: Number(final.eligible_count), added: Number(final.added), removed: Number(final.removed), skipped: Number(final.skipped), failed: Number(final.failed), batchesTotal: final.batches_total,
      funnel: { excludedByAudience: Number(final.excluded_by_audience), suppressed: Number(final.suppressed_count), consentDenied: Number(final.consent_denied_count), consentUnknown: Number(final.consent_unknown_count), consentExpired: Number(final.consent_expired_count), noIdentifier: Number(final.no_identifier_count), holdout: Number(final.holdout_count) } };
  }

  private emptyResult(status: string): SyncJobResult { return { jobId: '', status, sourceCount: 0, eligibleCount: 0, added: 0, removed: 0, skipped: 0, failed: 0, batchesTotal: 0, funnel: {} }; }

  private async loadContext(org: string, adId: string) {
    const ad = await this.db.selectFrom('audience_destinations').selectAll().where('id', '=', adId).where('organization_id', '=', org).executeTakeFirst();
    if (!ad) return null;
    const account = await this.db.selectFrom('destination_accounts').selectAll().where('id', '=', ad.destination_account_id).executeTakeFirstOrThrow();
    const destination = await this.db.selectFrom('destinations').selectAll().where('id', '=', account.destination_id).executeTakeFirstOrThrow();
    const audience = await this.db.selectFrom('audiences').selectAll().where('id', '=', ad.audience_id).executeTakeFirstOrThrow();
    const adapter = this.registry.get(destination.type);
    return { ad, account, destination, audience, adapter };
  }
  private adapterContext(destination: { id: string; organization_id: string; type: string; config: unknown; credential_ref: string | null }, dryRun: boolean): DestinationContext {
    return { destinationId: destination.id, organizationId: destination.organization_id, type: destination.type, config: (destination.config as Record<string, unknown>) ?? {}, credentialRef: destination.credential_ref, secrets: this.deps.secrets, fetch: this.deps.fetchImpl ?? fetch, log: this.log.child({ destination: destination.type }), dryRun };
  }

  /**
   * Eligibility + delta in one transaction. Produces sync_job_batches rows and flips
   * audience_destination_members states to PENDING_ADD / PENDING_REMOVE.
   */
  private async computeDelta(jobId: string, ctx: NonNullable<Awaited<ReturnType<DistributionEngine['loadContext']>>>, policy: CompliancePolicyRules, mode: SyncMode, now: Date) {
    const { ad, audience, adapter } = ctx;
    const dp = DistributionPolicySchema.parse(audience.distribution_policy ?? {});
    const reason = compilePolicyReasonExpr(policy, now);
    const holdoutPct = Number(audience.holdout_percent ?? 0);
    const batchSize = adapter.capabilities.maxBatchSize;
    await this.db.transaction().execute(async (trx) => {
      // eligibility over the source set
      await sql`CREATE TEMP TABLE aap_elig (customer_id bigint PRIMARY KEY, reason text, excluded boolean NOT NULL, holdout boolean NOT NULL) ON COMMIT DROP`.execute(trx);
      await sql`
        INSERT INTO aap_elig (customer_id, reason, excluded, holdout)
        SELECT m.customer_id, ${reason}, 
          EXISTS (SELECT 1 FROM audience_exclusions x JOIN audience_members xm ON xm.audience_id = x.excluded_audience_id AND xm.customer_id = m.customer_id AND xm.status = 'ACTIVE' WHERE x.audience_id = ${ad.audience_id}::uuid),
          ${holdoutPct > 0 ? sql`(('x' || substr(md5(${audience.holdout_salt} || ':' || m.customer_id::text), 1, 8))::bit(32)::bigint % 10000) < ${Math.round(holdoutPct * 100)}` : sql`false`}
        FROM audience_members m JOIN customers c ON c.id = m.customer_id
        WHERE m.audience_id = ${ad.audience_id}::uuid AND m.status = 'ACTIVE' ${dp.primaryOnly ? sql`AND m.is_primary` : sql``}`.execute(trx);
      if (holdoutPct > 0) {
        await sql`INSERT INTO holdout_assignments (audience_id, customer_id, "group") SELECT ${ad.audience_id}::uuid, customer_id, CASE WHEN holdout THEN 'CONTROL' ELSE 'TREATMENT' END FROM aap_elig WHERE NOT excluded AND reason IS NULL ON CONFLICT DO NOTHING`.execute(trx);
      }
      const f = (await sql<Record<string, number>>`
        SELECT count(*)::int AS source, count(*) FILTER (WHERE excluded)::int AS excluded,
          count(*) FILTER (WHERE NOT excluded AND reason = 'SUPPRESSED')::int AS suppressed, count(*) FILTER (WHERE NOT excluded AND reason = 'DELETED')::int AS deleted,
          count(*) FILTER (WHERE NOT excluded AND reason = 'CONSENT_DENIED')::int AS consent_denied, count(*) FILTER (WHERE NOT excluded AND reason = 'CONSENT_UNKNOWN')::int AS consent_unknown,
          count(*) FILTER (WHERE NOT excluded AND reason = 'CONSENT_EXPIRED')::int AS consent_expired, count(*) FILTER (WHERE NOT excluded AND reason IN ('NO_IDENTIFIER','INVALID_IDENTIFIER'))::int AS no_identifier,
          count(*) FILTER (WHERE NOT excluded AND reason IS NULL AND holdout)::int AS holdout,
          count(*) FILTER (WHERE NOT excluded AND reason IS NULL AND NOT holdout)::int AS eligible
        FROM aap_elig`.execute(trx)).rows[0]!;
      // eligible set E (respecting identifier kinds the distribution policy allows)
      const kinds = dp.identifierKinds;
      const profiles = kinds.map((k) => adapter.capabilities.hashProfiles[k]).filter((p): p is NonNullable<typeof p> => !!p);
      await sql`CREATE TEMP TABLE aap_e (customer_id bigint PRIMARY KEY) ON COMMIT DROP`.execute(trx);
      if (mode !== 'REMOVE_ALL') {
        await sql`INSERT INTO aap_e SELECT e.customer_id FROM aap_elig e WHERE NOT e.excluded AND e.reason IS NULL AND NOT e.holdout
          AND EXISTS (SELECT 1 FROM customer_identifiers ci WHERE ci.customer_id = e.customer_id AND ci.hash_profile = ANY(${profiles}::text[]))`.execute(trx);
      }
      const noIdentifierExtra = Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM aap_elig e WHERE NOT e.excluded AND e.reason IS NULL AND NOT e.holdout AND NOT EXISTS (SELECT 1 FROM aap_e x WHERE x.customer_id = e.customer_id)`.execute(trx)).rows[0]!.n);
      if (mode !== 'DRY_RUN') {
        // ADD: eligible and not already at destination (or FULL: everything eligible)
        await sql`
          INSERT INTO audience_destination_members (audience_destination_id, customer_id, state, last_sync_job_id, updated_at)
          SELECT ${ad.id}::uuid, e.customer_id, 'PENDING_ADD', ${jobId}::uuid, now() FROM aap_e e
          ON CONFLICT (audience_destination_id, customer_id) DO UPDATE SET state = 'PENDING_ADD', last_sync_job_id = ${jobId}::uuid, updated_at = now()
          WHERE ${mode === 'FULL' ? sql`true` : sql`audience_destination_members.state IN ('REMOVED','FAILED','SKIPPED','PENDING_REMOVE','PENDING_ADD')`}`.execute(trx);
        // REMOVE: synced but no longer eligible
        await sql`UPDATE audience_destination_members adm SET state = 'PENDING_REMOVE', last_sync_job_id = ${jobId}::uuid, updated_at = now()
          WHERE adm.audience_destination_id = ${ad.id}::uuid AND adm.state = 'SYNCED' AND NOT EXISTS (SELECT 1 FROM aap_e e WHERE e.customer_id = adm.customer_id)`.execute(trx);
        // PENDING_ADD from an older job that is no longer eligible → SKIPPED (never sent)
        await sql`UPDATE audience_destination_members adm SET state = 'SKIPPED', updated_at = now()
          WHERE adm.audience_destination_id = ${ad.id}::uuid AND adm.state = 'PENDING_ADD' AND adm.last_sync_job_id <> ${jobId}::uuid AND NOT EXISTS (SELECT 1 FROM aap_e e WHERE e.customer_id = adm.customer_id)`.execute(trx);
        // PENDING_REMOVE from an older job that is eligible again → still at destination → SYNCED
        await sql`UPDATE audience_destination_members adm SET state = 'SYNCED', updated_at = now()
          WHERE adm.audience_destination_id = ${ad.id}::uuid AND adm.state = 'PENDING_REMOVE' AND adm.last_sync_job_id <> ${jobId}::uuid AND EXISTS (SELECT 1 FROM aap_e e WHERE e.customer_id = adm.customer_id)`.execute(trx);
        // batches
        await sql`
          INSERT INTO sync_job_batches (sync_job_id, organization_id, seq, operation, member_count, customer_ids)
          SELECT ${jobId}::uuid, ${ad.organization_id}::uuid, row_number() OVER (ORDER BY op, grp)::int, op, count(*)::int, array_agg(customer_id ORDER BY customer_id)
          FROM (
            SELECT adm.customer_id, CASE WHEN adm.state = 'PENDING_ADD' THEN 'ADD' ELSE 'REMOVE' END AS op,
                   (row_number() OVER (PARTITION BY adm.state ORDER BY adm.customer_id) - 1) / ${batchSize} AS grp
            FROM audience_destination_members adm
            WHERE adm.audience_destination_id = ${ad.id}::uuid AND adm.state IN ('PENDING_ADD','PENDING_REMOVE')
          ) s GROUP BY op, grp`.execute(trx);
      }
      const counts = (await sql<{ adds: number; removes: number; batches: number }>`SELECT coalesce(sum(member_count) FILTER (WHERE operation='ADD'),0)::int AS adds, coalesce(sum(member_count) FILTER (WHERE operation='REMOVE'),0)::int AS removes, count(*)::int AS batches FROM sync_job_batches WHERE sync_job_id = ${jobId}::uuid`.execute(trx)).rows[0]!;
      const eligible = Number(f.eligible) - noIdentifierExtra;
      await trx.updateTable('sync_jobs').set({
        records_evaluated: Number(f.source), source_count: Number(f.source), eligible_count: eligible, excluded_by_audience: Number(f.excluded), suppressed_count: Number(f.suppressed) + Number(f.deleted),
        consent_denied_count: Number(f.consent_denied), consent_unknown_count: Number(f.consent_unknown), consent_expired_count: Number(f.consent_expired), no_identifier_count: Number(f.no_identifier) + noIdentifierExtra, holdout_count: Number(f.holdout),
        batches_total: counts.batches, checkpoint: JSON.stringify({ planned_adds: counts.adds, planned_removes: counts.removes, dry_run: mode === 'DRY_RUN' }),
        added: mode === 'DRY_RUN' ? counts.adds : 0,
      }).where('id', '=', jobId).execute();
      if (mode === 'DRY_RUN') {
        const e = Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM aap_e`.execute(trx)).rows[0]!.n);
        await trx.updateTable('sync_jobs').set({ added: e, checkpoint: JSON.stringify({ dry_run: true, estimated_payload_records: e, estimated_batches: Math.ceil(e / batchSize) }) }).where('id', '=', jobId).execute();
      }
    });
  }

  /** Processes PENDING/SENT batches of a job in order; returns delivery outcome. */
  private async deliverBatches(jobId: string, ctx: NonNullable<Awaited<ReturnType<DistributionEngine['loadContext']>>>, dctx: DestinationContext, externalAudienceId: string | null, mode: SyncMode) {
    const { ad, account, adapter } = ctx;
    const out = { succeeded: 0, failedBatches: 0, fatal: false, cancelled: false };
    if (mode === 'DRY_RUN') return out;
    const ref = { externalAudienceId: externalAudienceId!, externalAccountId: account.external_account_id };
    const batches = await this.db.selectFrom('sync_job_batches').select(['id', 'seq', 'operation', 'member_count', 'customer_ids', 'status', 'attempts', 'created_at']).where('sync_job_id', '=', jobId).where('status', 'in', ['PENDING', 'SENT']).orderBy('seq').execute();
    const total = batches.length;
    const sessionId = jobId;
    const profiles = Object.entries(adapter.capabilities.hashProfiles) as Array<['EMAIL' | 'PHONE', string]>;
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!;
      const j = await this.db.selectFrom('sync_jobs').select('status').where('id', '=', jobId).executeTakeFirst();
      if (j?.status === 'CANCELLED') { out.cancelled = true; break; }
      const ids = (b.customer_ids as Array<number | string>).map(Number);
      const members = await this.loadMembers(ids, profiles);
      const missing = ids.length - members.length;
      let attempt = b.attempts;
      let done = false;
      while (!done) {
        attempt++;
        await this.db.updateTable('sync_job_batches').set({ status: 'SENT', attempts: attempt, started_at: new Date() }).where('sync_job_id', '=', jobId).where('seq', '=', b.seq).execute();
        try {
          const meta = { sessionId, batchSeq: b.seq, isLast: i === total - 1, estimatedTotal: total * adapter.capabilities.maxBatchSize };
          const res = members.length ? (b.operation === 'ADD' ? await adapter.addMembers(dctx, ref, members, meta) : await adapter.removeMembers(dctx, ref, members, meta)) : { received: 0, invalid: 0 };
          await this.db.transaction().execute(async (trx) => {
            await trx.updateTable('sync_job_batches').set({ status: 'SUCCEEDED', finished_at: new Date(), external_ref: res.externalRef ?? null, response_summary: JSON.stringify(res.summary ?? {}) }).where('sync_job_id', '=', jobId).where('seq', '=', b.seq).execute();
            const sentIds = members.map((m) => m.customerId);
            if (b.operation === 'ADD') {
              if (sentIds.length) await trx.updateTable('audience_destination_members').set({ state: 'SYNCED', added_at: new Date(), last_attempt_at: new Date(), attempts: sql`attempts + 1`, identifier_kinds: profiles.map((p) => p[0]), updated_at: new Date() })
                .where('audience_destination_id', '=', ad.id).where('customer_id', 'in', sentIds).execute();
            } else if (sentIds.length) {
              await trx.updateTable('audience_destination_members').set({ state: 'REMOVED', removed_at: new Date(), last_attempt_at: new Date(), updated_at: new Date() }).where('audience_destination_id', '=', ad.id).where('customer_id', 'in', sentIds).execute();
            }
            if (missing > 0) {
              const missingIds = ids.filter((x) => !sentIds.includes(x));
              await trx.updateTable('audience_destination_members').set({ state: 'SKIPPED', last_error_code: 'NO_IDENTIFIER', updated_at: new Date() }).where('audience_destination_id', '=', ad.id).where('customer_id', 'in', missingIds).execute();
            }
            await trx.updateTable('sync_jobs').set({
              batches_done: sql`batches_done + 1`, skipped: sql`skipped + ${missing}`,
              added: b.operation === 'ADD' ? sql`added + ${sentIds.length}` : undefined, removed: b.operation === 'REMOVE' ? sql`removed + ${sentIds.length}` : undefined,
              failed: sql`failed + ${res.invalid ?? 0}`,
            }).where('id', '=', jobId).execute();
          });
          out.succeeded++; done = true;
        } catch (e) {
          const de = e instanceof DestinationError ? e : new DestinationError(sanitizeError(e), 'UNKNOWN', false);
          this.log.warn({ jobId, seq: b.seq, kind: de.kind, code: de.opts.code, attempt }, 'batch failed');
          if (de.retryable && attempt < 6) { await sleep(Math.min(de.opts.retryAfterMs ?? 1000 * 2 ** attempt, 120_000)); continue; }
          // terminal for this batch
          await this.db.transaction().execute(async (trx) => {
            await trx.updateTable('sync_job_batches').set({ status: 'FAILED', finished_at: new Date(), error_code: `${de.kind}${de.opts.code ? ':' + de.opts.code : ''}`, error_message: sanitizeError(de.message) }).where('sync_job_id', '=', jobId).where('seq', '=', b.seq).execute();
            await trx.updateTable('audience_destination_members').set({ state: 'FAILED', last_error_code: de.kind, last_attempt_at: new Date(), attempts: sql`attempts + 1`, updated_at: new Date() }).where('audience_destination_id', '=', ad.id).where('customer_id', 'in', ids).execute();
            await trx.updateTable('sync_jobs').set({ batches_done: sql`batches_done + 1`, failed: sql`failed + ${ids.length}`, warnings: sql`warnings || ${JSON.stringify([{ seq: b.seq, kind: de.kind, code: de.opts.code ?? null }])}::jsonb` }).where('id', '=', jobId).execute();
          });
          out.failedBatches++; done = true;
          if (de.kind === 'AUTH_EXPIRED' || de.kind === 'PERMISSION_DENIED' || de.kind === 'NOT_FOUND') {
            await this.handleFatal(ad.id, de);
            await this.db.updateTable('sync_jobs').set({ error: `${de.kind}: ${sanitizeError(de.message)}` }).where('id', '=', jobId).execute();
            out.fatal = true; break;
          }
        }
      }
    }
    return out;
  }

  private async loadMembers(ids: number[], profiles: Array<['EMAIL' | 'PHONE', string]>): Promise<MemberRecord[]> {
    if (!ids.length || !profiles.length) return [];
    const rows = await this.db.selectFrom('customer_identifiers').select(['customer_id', 'kind', 'hash', 'hash_profile']).where('customer_id', 'in', ids).where('hash_profile', 'in', profiles.map((p) => p[1])).execute();
    const m = new Map<number, MemberRecord>();
    for (const r of rows) {
      const rec = m.get(r.customer_id) ?? { customerId: r.customer_id, identifiers: [] };
      rec.identifiers.push({ kind: r.kind as 'EMAIL' | 'PHONE', hashHex: r.hash.toString('hex') });
      m.set(r.customer_id, rec);
    }
    return ids.map((id) => m.get(id)).filter((x): x is MemberRecord => !!x);
  }

  private async refreshCounters(adId: string, ctx: NonNullable<Awaited<ReturnType<DistributionEngine['loadContext']>>>, dctx: DestinationContext, externalAudienceId: string | null, now: Date) {
    const { ad, account, audience, adapter } = ctx;
    const c = (await sql<{ synced: number; source: number }>`SELECT (SELECT count(*)::int FROM audience_destination_members WHERE audience_destination_id = ${adId}::uuid AND state = 'SYNCED') AS synced, (SELECT count(*)::int FROM audience_members WHERE audience_id = ${ad.audience_id}::uuid AND status = 'ACTIVE') AS source`.execute(this.db)).rows[0]!;
    const lastJob = await this.db.selectFrom('sync_jobs').select(['eligible_count']).where('audience_destination_id', '=', adId).orderBy('created_at', 'desc').executeTakeFirst();
    let platform: Record<string, unknown> = {}; let matched: number | null = null, lower: number | null = null, upper: number | null = null, matchRate: number | null = null;
    if (externalAudienceId) {
      try {
        const s = await adapter.getStatus(dctx, { externalAudienceId, externalAccountId: account.external_account_id });
        platform = { ...s.raw, delivery_status: s.deliveryStatus, operation_status: s.operationStatus, checked_at: new Date().toISOString() };
        lower = s.approximateLower ?? null; upper = s.approximateUpper ?? null;
        matched = s.approximateCount ?? (lower != null && upper != null ? Math.round((lower + upper) / 2) : null);
        matchRate = s.matchRate ?? (matched != null && c.synced > 0 ? Math.min(100, Math.round((matched / c.synced) * 10000) / 100) : null);
      } catch (e) { this.log.warn({ adId, err: sanitizeError(e) }, 'getStatus failed'); }
    }
    const schedule = ad.sync_schedule ?? audience.evaluation_schedule;
    const interval = scheduleIntervalSeconds(schedule);
    await this.db.updateTable('audience_destinations').set({
      source_count: c.source, eligible_count: Number(lastJob?.eligible_count ?? 0), submitted_count: c.synced, matched_count: matched, matched_lower: lower, matched_upper: upper, match_rate: matchRate,
      platform_status: JSON.stringify(platform), last_synced_at: now, next_sync_at: interval ? new Date(now.getTime() + interval * 1000) : null, updated_at: new Date(), last_error: null,
    }).where('id', '=', adId).execute();
    await this.db.updateTable('destinations').set({ last_sync_at: now }).where('id', '=', ctx.destination.id).execute();
    await this.db.updateTable('audiences').set({ eligible_count: Number(lastJob?.eligible_count ?? 0) }).where('id', '=', ad.audience_id).execute();
    void pct;
  }

  private async flagError(adId: string, message: string) {
    await this.db.updateTable('audience_destinations').set({ status: 'ERROR', last_error: sanitizeError(message), updated_at: new Date() }).where('id', '=', adId).execute();
  }
  private async handleFatal(adId: string, e: unknown) {
    const de = e instanceof DestinationError ? e : null;
    await this.flagError(adId, de ? `${de.kind}: ${de.message}` : sanitizeError(e));
    if (de && (de.kind === 'AUTH_EXPIRED' || de.kind === 'PERMISSION_DENIED')) {
      const ad = await this.db.selectFrom('audience_destinations as ad').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').select(['da.destination_id', 'ad.organization_id']).where('ad.id', '=', adId).executeTakeFirst();
      if (ad) {
        await this.db.updateTable('destinations').set({ status: 'ERROR', last_error: `${de.kind}: ${sanitizeError(de.message)}`, updated_at: new Date() }).where('id', '=', ad.destination_id).execute();
        await this.audit.log({ organizationId: ad.organization_id, actor: SYSTEM_ACTOR, action: 'DESTINATION_ERROR', entityType: 'destination', entityId: ad.destination_id, metadata: { kind: de.kind, code: de.opts.code ?? null } });
      }
    }
  }

  /**
   * Mock destinations keep state in memory; rebuild it from our own records so restarts don't
   * lose the simulated platform state (no-op for live adapters).
   */
  async hydrateMockDestinations(): Promise<number> {
    const rows = await this.db.selectFrom('audience_destinations as ad').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id')
      .select(['ad.id', 'ad.external_audience_id', 'ad.external_audience_name', 'da.external_account_id', 'd.type']).where('ad.status', 'in', ['ACTIVE', 'PAUSED', 'ERROR']).where('ad.external_audience_id', 'is not', null).execute();
    let n = 0;
    for (const r of rows) {
      if (!this.registry.isMock(r.type)) continue;
      const adapter = this.registry.get(r.type) as unknown as { hydrate?: (ref: { externalAudienceId: string; externalAccountId: string }, name: string, members: MemberRecord[]) => void };
      if (!adapter.hydrate) continue;
      const profiles = Object.entries(this.registry.get(r.type).capabilities.hashProfiles) as Array<['EMAIL' | 'PHONE', string]>;
      let cursor = 0;
      for (;;) {
        const ids = (await this.db.selectFrom('audience_destination_members').select('customer_id').where('audience_destination_id', '=', r.id).where('state', '=', 'SYNCED').where('customer_id', '>', cursor).orderBy('customer_id').limit(10_000).execute()).map((x) => Number(x.customer_id));
        if (!ids.length) break;
        adapter.hydrate({ externalAudienceId: r.external_audience_id!, externalAccountId: r.external_account_id }, r.external_audience_name ?? r.external_audience_id!, await this.loadMembers(ids, profiles));
        cursor = ids[ids.length - 1]!; n += ids.length;
      }
    }
    return n;
  }

  async cancelJob(principal: Principal, jobId: string) {
    assertCan(principal, 'audiences:activate');
    await this.db.updateTable('sync_jobs').set({ status: 'CANCELLED', finished_at: new Date() }).where('id', '=', jobId).where('organization_id', '=', principal.organizationId).where('status', 'in', ['QUEUED', 'RUNNING', 'PAUSED']).execute();
  }
  async retryJob(principal: Principal, jobId: string) {
    assertCan(principal, 'audiences:activate');
    const j = await this.db.selectFrom('sync_jobs').selectAll().where('id', '=', jobId).where('organization_id', '=', principal.organizationId).executeTakeFirst();
    if (!j) throw new NotFoundError('Sync job not found');
    // failed batches → PENDING again, members back to pending states; then re-run the same job
    await this.db.transaction().execute(async (trx) => {
      const failed = await trx.selectFrom('sync_job_batches').select(['id', 'seq', 'operation', 'customer_ids']).where('sync_job_id', '=', jobId).where('status', '=', 'FAILED').execute();
      for (const b of failed) {
        await trx.updateTable('sync_job_batches').set({ status: 'PENDING', error_code: null, error_message: null }).where('sync_job_id', '=', jobId).where('seq', '=', b.seq).execute();
        await trx.updateTable('audience_destination_members').set({ state: b.operation === 'ADD' ? 'PENDING_ADD' : 'PENDING_REMOVE' }).where('audience_destination_id', '=', j.audience_destination_id).where('customer_id', 'in', (b.customer_ids as Array<number | string>).map(Number)).where('state', '=', 'FAILED').execute();
      }
      await trx.updateTable('sync_jobs').set({ status: 'QUEUED', failed: 0, batches_done: sql`batches_done - ${failed.length}`, error: null }).where('id', '=', jobId).execute();
    });
    await this.deps.queue.enqueue({ queue: QUEUES.sync, name: 'sync-audience-destination', payload: { organizationId: j.organization_id, audienceDestinationId: j.audience_destination_id, trigger: 'RETRY', mode: j.mode, resumeJobId: jobId }, priority: 30 });
  }
}
