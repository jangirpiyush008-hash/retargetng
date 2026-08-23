import { loadEnv, createDbWithPool } from '@aap/db';
loadEnv();
import http from 'node:http';
import { createJobQueue, QUEUES, type Job, CustomerEventProcessor, MembershipEngine, DistributionEngine, createSecretStore, DestinationRegistry,
  metrics, logger, sanitizeError, EventIngestor, MaintenanceService, DataQualityService, MeasurementService, scheduleIntervalSeconds, AudienceService, RetryableJobError } from '@aap/core';
import { sql } from 'kysely';

const log = logger().child({ service: 'worker' });
const { db, pool } = createDbWithPool({ applicationName: 'aap-worker', max: Number(process.env.WORKER_PG_POOL ?? 12) });
const queue = createJobQueue(db);
const secrets = createSecretStore(db);
const registry = new DestinationRegistry();
const processor = new CustomerEventProcessor(db);
const membership = new MembershipEngine(db);
const distribution = new DistributionEngine({ db, queue, secrets, registry });
const ingestor = new EventIngestor(db, queue);
const maintenance = new MaintenanceService(db);
const quality = new DataQualityService(db);
const measurement = new MeasurementService(db);
const audiences = new AudienceService(db, queue);

// ---------------------------------------------------------------- handlers
async function handle(job: Job): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = job.payload as Record<string, any>;
  switch (job.name) {
    case 'process-events': {
      const r = await processor.processEventIds(p.organizationId, p.events);
      log.debug({ ...r, jobId: job.id }, 'events processed');
      return;
    }
    case 'evaluate-audience': {
      const r = await membership.evaluate(p.audienceId, { mode: p.mode });
      log.info({ audienceId: p.audienceId, ...r }, 'audience evaluated');
      // REALTIME audiences push changes to destinations immediately
      if (r.entered + r.exited > 0) {
        const ads = await db.selectFrom('audience_destinations as ad').innerJoin('audiences as a', 'a.id', 'ad.audience_id').select(['ad.id', 'ad.organization_id'])
          .where('ad.audience_id', '=', p.audienceId).where('ad.status', '=', 'ACTIVE').where(sql<boolean>`coalesce(ad.sync_schedule, a.evaluation_schedule) = 'REALTIME'`).execute();
        for (const ad of ads) await distribution.enqueueSync(ad.organization_id, ad.id, 'EVENT');
      }
      return;
    }
    case 'sync-audience-destination': {
      const r = await distribution.runSync({ organizationId: p.organizationId, audienceDestinationId: p.audienceDestinationId, trigger: p.trigger, mode: p.mode, createdBy: p.createdBy ?? null, resumeJobId: p.resumeJobId });
      log.info({ ...r, funnel: undefined }, 'sync finished');
      if (r.status === 'FAILED') throw new RetryableJobError('sync failed; will retry', 5 * 60_000);
      return;
    }
    case 'audience-status-changed': return distribution.onAudienceStatusChanged(p.organizationId, p.audienceId, p.status);
    case 'maintenance': return runMaintenance(p.task, p);
    default: log.warn({ name: job.name }, 'unknown job');
  }
}

async function runMaintenance(task: string, p: Record<string, unknown>) {
  const orgs = (await db.selectFrom('organizations').select('id').execute()).map((o) => o.id);
  switch (task) {
    case 'lifecycle': { const now = new Date(); const since = new Date(now.getTime() - 2 * 3600_000); for (const o of orgs) { const n = await maintenance.applyLifecycleTimeTransitions(o, since, now); if (n) log.info({ org: o, n }, 'lifecycle transitions'); } return; }
    case 'stats': { for (const o of orgs) await measurement.refreshCustomerStats(o); return; }
    case 'primary': { const to = new Date(); const from = new Date(to.getTime() - 2 * 3600_000); for (const o of orgs) await membership.recomputePrimary(o, from, to); return; }
    case 'suppression-sweep': { for (const o of orgs) { const n = await distribution.sweepSuppressed(o, new Date(Date.now() - 15 * 60_000)); if (n) log.info({ org: o, n }, 'suppression sweep enqueued syncs'); } return; }
    case 'pending-events': { const n = await ingestor.sweepPending(null, 300); if (n) log.info({ n }, 'pending events re-enqueued'); return; }
    case 'daily': {
      await maintenance.resetDailyCounters(); await maintenance.ensurePartitions();
      for (const o of orgs) { await maintenance.applyRetention(o); await quality.compute(o); }
      const holdouts = await db.selectFrom('audiences').select('id').where('holdout_percent', '>', 0).where('status', '=', 'ACTIVE').execute();
      for (const a of holdouts) await measurement.rollupHoldoutOutcomes(a.id, new Date(Date.now() - 3 * 86400_000), new Date());
      return;
    }
    case 'reconcile': {
      // weekly safety net: full diff per active audience, spread out at low priority
      const due = await db.selectFrom('audiences').select(['id', 'organization_id']).where('status', '=', 'ACTIVE').where((eb) => eb.or([eb('last_eval_mode', 'is', null), sql<boolean>`NOT EXISTS (SELECT 1 FROM audience_eval_runs r WHERE r.audience_id = audiences.id AND r.mode IN ('FULL','RECONCILE') AND r.status = 'SUCCESS' AND r.started_at > now() - interval '7 days')`])).limit(Number(p.limit ?? 50)).execute();
      for (const a of due) await audiences.enqueueEvaluation(a.organization_id, a.id, 'RECONCILE');
      return;
    }
    default: log.warn({ task }, 'unknown maintenance task');
  }
}

// ---------------------------------------------------------------- scheduler
let lastDaily = '';
async function schedulerTick() {
  try {
    for (const a of await membership.dueAudiences(300)) await audiences.enqueueEvaluation(a.organization_id, a.id, 'INCREMENTAL');
    for (const s of await distribution.dueSyncs(300)) await distribution.enqueueSync(s.organization_id, s.id, 'SCHEDULED');
    const minute = new Date().getUTCMinutes();
    if (minute % 5 === 0) { await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'suppression-sweep' }, idempotencyKey: 'maint:suppression-sweep', priority: 20 }); await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'pending-events' }, idempotencyKey: 'maint:pending-events', priority: 50 }); }
    if (minute === 0) { await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'lifecycle' }, idempotencyKey: 'maint:lifecycle', priority: 60 }); await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'primary' }, idempotencyKey: 'maint:primary', priority: 70 }); await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'stats' }, idempotencyKey: 'maint:stats', priority: 75 }); }
    const day = new Date().toISOString().slice(0, 10);
    if (day !== lastDaily && new Date().getUTCHours() >= 1) { lastDaily = day; await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'daily' }, idempotencyKey: `maint:daily:${day}`, priority: 90 }); await queue.enqueue({ queue: QUEUES.maintenance, name: 'maintenance', payload: { task: 'reconcile' }, idempotencyKey: `maint:reconcile:${day}`, priority: 95 }); }
    await queue.stats();
  } catch (e) { log.error({ err: sanitizeError(e) }, 'scheduler tick failed'); }
}

// ---------------------------------------------------------------- http (health/ready/metrics)
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'worker', uptime: process.uptime() })); return; }
    if (req.url === '/ready') { await sql`select 1`.execute(db); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, db: 'up', pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } })); return; }
    if (req.url === '/metrics') { metrics.dbPool.set(pool.totalCount, { stat: 'total' }); metrics.dbPool.set(pool.idleCount, { stat: 'idle' }); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(metrics.render()); return; }
    if (req.url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(await queue.stats())); return; }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: sanitizeError(e) })); }
});

// ---------------------------------------------------------------- boot
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 6);
if (registry.currentMode === 'mock') { const n = await distribution.hydrateMockDestinations(); log.info({ members: n }, 'mock destination state hydrated from database'); }
await queue.start({ queues: [QUEUES.events, QUEUES.evaluate, QUEUES.sync, QUEUES.maintenance, QUEUES.ingest], concurrency, handler: handle });
const timer = setInterval(schedulerTick, Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000));
void schedulerTick();
const port = Number(process.env.WORKER_PORT ?? 9464);
server.listen(port, () => log.info({ port, concurrency, destinationMode: registry.currentMode }, 'worker started'));

async function shutdown(sig: string) {
  log.info({ sig }, 'shutting down');
  clearInterval(timer); server.close();
  await queue.stop(); await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
