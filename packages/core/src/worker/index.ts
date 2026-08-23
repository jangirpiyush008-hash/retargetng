import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@aap/db';
import { CustomerEventProcessor } from '../events/processor.js';
import { EventIngestor } from '../events/ingest.js';
import { MembershipEngine } from '../membership/engine.js';
import { DistributionEngine } from '../distribution/engine.js';
import { AudienceService } from '../audience/service.js';
import { MeasurementService } from '../measurement/index.js';
import { DataQualityService } from '../quality/index.js';
import { MaintenanceService } from '../platform/maintenance.js';
import { DestinationRegistry } from '../destinations/registry.js';
import { QUEUES } from '../queue/index.js';
import { RetryableJobError, type Job, type JobQueue } from '../queue/types.js';
import type { SecretStore } from '../secrets/index.js';
import { logger, sanitizeError } from '../observability/logger.js';

export interface WorkerRuntimeOptions {
  db: Kysely<DB>;
  queue: JobQueue;
  secrets: SecretStore;
  registry?: DestinationRegistry;
  /** label used in logs (worker process vs in-process demo worker) */
  name?: string;
}

/**
 * The background engine: queue consumers + the scheduler that keeps audiences evaluated,
 * destinations in sync, lifecycle states current and retention applied.
 *
 * Shared by the standalone worker process and — when the app runs on the embedded database —
 * by the web app itself, so a single container is a complete, working system.
 */
export class WorkerRuntime {
  private log;
  private db: Kysely<DB>;
  private queue: JobQueue;
  private registry: DestinationRegistry;
  readonly processor: CustomerEventProcessor;
  readonly membership: MembershipEngine;
  readonly distribution: DistributionEngine;
  readonly audiences: AudienceService;
  readonly ingestor: EventIngestor;
  readonly maintenance: MaintenanceService;
  readonly quality: DataQualityService;
  readonly measurement: MeasurementService;
  private timer?: NodeJS.Timeout;
  private lastDaily = '';

  constructor(opts: WorkerRuntimeOptions) {
    this.db = opts.db;
    this.queue = opts.queue;
    this.registry = opts.registry ?? new DestinationRegistry();
    this.log = logger().child({ service: opts.name ?? 'worker' });
    this.processor = new CustomerEventProcessor(opts.db);
    this.membership = new MembershipEngine(opts.db);
    this.distribution = new DistributionEngine({ db: opts.db, queue: opts.queue, secrets: opts.secrets, registry: this.registry });
    this.audiences = new AudienceService(opts.db, opts.queue);
    this.ingestor = new EventIngestor(opts.db, opts.queue);
    this.maintenance = new MaintenanceService(opts.db);
    this.quality = new DataQualityService(opts.db);
    this.measurement = new MeasurementService(opts.db);
  }

  /** Processes one job. Exported so tests and the drain helper can call it directly. */
  handle = async (job: Job): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = job.payload as Record<string, any>;
    switch (job.name) {
      case 'process-events': {
        const r = await this.processor.processEventIds(p.organizationId, p.events);
        this.log.debug({ ...r, jobId: job.id }, 'events processed');
        return;
      }
      case 'evaluate-audience': {
        const r = await this.membership.evaluate(p.audienceId, { mode: p.mode });
        this.log.info({ audienceId: p.audienceId, ...r }, 'audience evaluated');
        if (r.entered + r.exited > 0) {
          const ads = await this.db
            .selectFrom('audience_destinations as ad')
            .innerJoin('audiences as a', 'a.id', 'ad.audience_id')
            .select(['ad.id', 'ad.organization_id'])
            .where('ad.audience_id', '=', p.audienceId)
            .where('ad.status', '=', 'ACTIVE')
            .where(sql<boolean>`coalesce(ad.sync_schedule, a.evaluation_schedule) = 'REALTIME'`)
            .execute();
          for (const ad of ads) await this.distribution.enqueueSync(ad.organization_id, ad.id, 'EVENT');
        }
        return;
      }
      case 'sync-audience-destination': {
        const r = await this.distribution.runSync({
          organizationId: p.organizationId,
          audienceDestinationId: p.audienceDestinationId,
          trigger: p.trigger,
          mode: p.mode,
          createdBy: p.createdBy ?? null,
          resumeJobId: p.resumeJobId,
        });
        this.log.info({ ...r, funnel: undefined }, 'sync finished');
        if (r.status === 'FAILED') throw new RetryableJobError('sync failed; will retry', 5 * 60_000);
        return;
      }
      case 'audience-status-changed':
        return this.distribution.onAudienceStatusChanged(p.organizationId, p.audienceId, p.status);
      case 'maintenance':
        return this.runMaintenance(p.task, p);
      default:
        this.log.warn({ name: job.name }, 'unknown job');
    }
  };

  async runMaintenance(task: string, p: Record<string, unknown> = {}): Promise<void> {
    const orgs = (await this.db.selectFrom('organizations').select('id').execute()).map((o) => o.id);
    switch (task) {
      case 'lifecycle': {
        const now = new Date();
        const since = new Date(now.getTime() - 2 * 3600_000);
        for (const o of orgs) {
          const n = await this.maintenance.applyLifecycleTimeTransitions(o, since, now);
          if (n) this.log.info({ org: o, n }, 'lifecycle transitions');
        }
        return;
      }
      case 'stats': {
        for (const o of orgs) await this.measurement.refreshCustomerStats(o);
        return;
      }
      case 'primary': {
        const to = new Date();
        const from = new Date(to.getTime() - 2 * 3600_000);
        for (const o of orgs) await this.membership.recomputePrimary(o, from, to);
        return;
      }
      case 'suppression-sweep': {
        for (const o of orgs) {
          const n = await this.distribution.sweepSuppressed(o, new Date(Date.now() - 15 * 60_000));
          if (n) this.log.info({ org: o, n }, 'suppression sweep enqueued syncs');
        }
        return;
      }
      case 'pending-events': {
        const n = await this.ingestor.sweepPending(null, 300);
        if (n) this.log.info({ n }, 'pending events re-enqueued');
        return;
      }
      case 'daily': {
        await this.maintenance.resetDailyCounters();
        await this.maintenance.ensurePartitions();
        for (const o of orgs) {
          await this.maintenance.applyRetention(o);
          await this.quality.compute(o);
        }
        const holdouts = await this.db.selectFrom('audiences').select('id').where('holdout_percent', '>', 0).where('status', '=', 'ACTIVE').execute();
        for (const a of holdouts) await this.measurement.rollupHoldoutOutcomes(a.id, new Date(Date.now() - 3 * 86400_000), new Date());
        return;
      }
      case 'reconcile': {
        const due = await this.db
          .selectFrom('audiences')
          .select(['id', 'organization_id'])
          .where('status', '=', 'ACTIVE')
          .where((eb) =>
            eb.or([
              eb('last_eval_mode', 'is', null),
              sql<boolean>`NOT EXISTS (SELECT 1 FROM audience_eval_runs r WHERE r.audience_id = audiences.id AND r.mode IN ('FULL','RECONCILE') AND r.status = 'SUCCESS' AND r.started_at > now() - interval '7 days')`,
            ]),
          )
          .limit(Number(p.limit ?? 50))
          .execute();
        for (const a of due) await this.audiences.enqueueEvaluation(a.organization_id, a.id, 'RECONCILE');
        return;
      }
      default:
        this.log.warn({ task }, 'unknown maintenance task');
    }
  }

  /** One scheduler pass: enqueue due evaluations, due syncs and periodic maintenance. */
  async tick(): Promise<void> {
    try {
      for (const a of await this.membership.dueAudiences(300)) await this.audiences.enqueueEvaluation(a.organization_id, a.id, 'INCREMENTAL');
      for (const s of await this.distribution.dueSyncs(300)) await this.distribution.enqueueSync(s.organization_id, s.id, 'SCHEDULED');
      const minute = new Date().getUTCMinutes();
      if (minute % 5 === 0) {
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'suppression-sweep' }, idempotencyKey: 'maint:suppression-sweep', priority: 20 });
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'pending-events' }, idempotencyKey: 'maint:pending-events', priority: 50 });
      }
      if (minute === 0) {
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'lifecycle' }, idempotencyKey: 'maint:lifecycle', priority: 60 });
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'primary' }, idempotencyKey: 'maint:primary', priority: 70 });
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'stats' }, idempotencyKey: 'maint:stats', priority: 75 });
      }
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.lastDaily && new Date().getUTCHours() >= 1) {
        this.lastDaily = day;
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'daily' }, idempotencyKey: `maint:daily:${day}`, priority: 90 });
        await this.queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'reconcile' }, idempotencyKey: `maint:reconcile:${day}`, priority: 95 });
      }
      await this.queue.stats();
    } catch (e) {
      this.log.error({ err: sanitizeError(e) }, 'scheduler tick failed');
    }
  }

  /** Starts queue consumers and the scheduler loop. */
  async start(opts: { concurrency?: number; schedulerIntervalMs?: number; hydrateMocks?: boolean } = {}): Promise<void> {
    if (opts.hydrateMocks !== false && this.registry.currentMode === 'mock') {
      const n = await this.distribution.hydrateMockDestinations().catch(() => 0);
      if (n) this.log.info({ members: n }, 'mock destination state hydrated from database');
    }
    await this.queue.start({
      queues: [QUEUES.events, QUEUES.evaluate, QUEUES.sync, QUEUES.maintenance, QUEUES.ingest],
      concurrency: opts.concurrency ?? 6,
      handler: this.handle,
    });
    const interval = opts.schedulerIntervalMs ?? 30_000;
    this.timer = setInterval(() => void this.tick(), interval);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.stop();
  }
}
