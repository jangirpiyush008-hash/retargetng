import { sql, type Kysely } from 'kysely';
import type { DB } from '@aap/db';
import type { EnqueueInput, Job, JobHandler, JobQueue, QueueStats } from './types.js';
import { RetryableJobError } from './types.js';
import { backoffMs, sleep } from '../util/time.js';
import { logger, sanitizeError } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

/**
 * Durable Postgres-backed queue: FOR UPDATE SKIP LOCKED leasing, lease expiry, exponential
 * backoff retries, dead-lettering, idempotency keys. Good to ~thousands of jobs/sec on a
 * single instance; swap for BullMQ (same interface) beyond that.
 */
export class PgJobQueue implements JobQueue {
  private running = false;
  private loops: Promise<void>[] = [];
  private log = logger().child({ module: 'pg-queue' });
  constructor(private db: Kysely<DB>) {}

  async enqueue(input: EnqueueInput): Promise<{ id: string; deduplicated: boolean }> {
    const r = await this.db.insertInto('job_queue').values({
      queue: input.queue, name: input.name, payload: JSON.stringify(input.payload),
      idempotency_key: input.idempotencyKey ?? null, run_at: input.runAt ?? new Date(),
      priority: input.priority ?? 100, max_attempts: input.maxAttempts ?? 5,
    }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
    if (r) return { id: String(r.id), deduplicated: false };
    const existing = await this.db.selectFrom('job_queue').select('id').where('idempotency_key', '=', input.idempotencyKey!).where('status', 'in', ['PENDING', 'RUNNING']).executeTakeFirst();
    return { id: String(existing?.id ?? ''), deduplicated: true };
  }

  async lease(queues: string[], workerId: string, n: number, leaseSeconds = 600): Promise<Job[]> {
    const rows = await sql<{ id: number; queue: string; name: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>`
      WITH cte AS (
        SELECT id FROM job_queue
        WHERE status = 'PENDING' AND queue = ANY(${queues}::text[]) AND run_at <= now()
        ORDER BY priority, run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${n}
      )
      UPDATE job_queue j SET status = 'RUNNING', locked_at = now(), locked_by = ${workerId}, attempts = j.attempts + 1, lease_seconds = ${leaseSeconds}
      FROM cte WHERE j.id = cte.id
      RETURNING j.id, j.queue, j.name, j.payload, j.attempts, j.max_attempts`.execute(this.db);
    return rows.rows.map((r) => ({ id: String(r.id), queue: r.queue, name: r.name, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
  }

  async complete(job: Job): Promise<void> {
    await this.db.updateTable('job_queue').set({ status: 'COMPLETED', completed_at: new Date(), locked_at: null, locked_by: null }).where('id', '=', Number(job.id)).execute();
  }

  async fail(job: Job, error: string, retryInMs?: number): Promise<void> {
    const canRetry = job.attempts < job.maxAttempts;
    const delay = retryInMs ?? backoffMs(job.attempts, 2000, 10 * 60_000);
    await this.db.updateTable('job_queue').set(canRetry
      ? { status: 'PENDING', run_at: new Date(Date.now() + delay), last_error: error, locked_at: null, locked_by: null }
      : { status: 'DEAD', last_error: error, locked_at: null, locked_by: null, completed_at: new Date() })
      .where('id', '=', Number(job.id)).execute();
  }

  async heartbeat(job: Job): Promise<void> {
    await this.db.updateTable('job_queue').set({ locked_at: new Date() }).where('id', '=', Number(job.id)).execute();
  }

  /** Re-queue jobs whose worker disappeared (lease expired). */
  async reapExpiredLeases(): Promise<number> {
    const r = await sql<{ n: number }>`WITH u AS (UPDATE job_queue SET status='PENDING', locked_at=NULL, locked_by=NULL, last_error=coalesce(last_error,'') || ' [lease expired]'
      WHERE status='RUNNING' AND locked_at < now() - make_interval(secs => lease_seconds) RETURNING 1) SELECT count(*)::int AS n FROM u`.execute(this.db);
    return r.rows[0]?.n ?? 0;
  }

  async start(opts: { queues: string[]; concurrency: number; handler: JobHandler; workerId?: string; pollIntervalMs?: number }): Promise<void> {
    this.running = true;
    const workerId = opts.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const poll = opts.pollIntervalMs ?? 500;
    for (let i = 0; i < opts.concurrency; i++) {
      this.loops.push((async () => {
        while (this.running) {
          let jobs: Job[] = [];
          try { jobs = await this.lease(opts.queues, workerId, 1); } catch (e) { this.log.error({ err: sanitizeError(e) }, 'lease failed'); await sleep(poll * 4); continue; }
          if (!jobs.length) { await sleep(poll + Math.random() * poll); continue; }
          const job = jobs[0]!;
          const hb = setInterval(() => { this.heartbeat(job).catch(() => {}); }, 60_000);
          try {
            await opts.handler(job, { heartbeat: () => this.heartbeat(job), workerId });
            await this.complete(job);
            metrics.jobsProcessed.inc({ queue: job.queue, name: job.name });
          } catch (e) {
            metrics.jobsFailed.inc({ queue: job.queue, name: job.name });
            const msg = sanitizeError(e);
            this.log.warn({ jobId: job.id, queue: job.queue, name: job.name, attempt: job.attempts, err: msg }, 'job failed');
            await this.fail(job, msg, e instanceof RetryableJobError ? e.retryInMs : undefined).catch(() => {});
          } finally { clearInterval(hb); }
        }
      })());
    }
    // lease reaper
    this.loops.push((async () => { while (this.running) { try { await this.reapExpiredLeases(); } catch { /* ignore */ } await sleep(60_000); } })());
  }

  async stop(): Promise<void> { this.running = false; await Promise.allSettled(this.loops); this.loops = []; }

  async stats(): Promise<QueueStats[]> {
    const rows = await sql<{ queue: string; status: string; n: number }>`SELECT queue, status, count(*)::int AS n FROM job_queue WHERE status <> 'COMPLETED' GROUP BY 1,2`.execute(this.db);
    const m = new Map<string, QueueStats>();
    for (const r of rows.rows) {
      const s = m.get(r.queue) ?? { queue: r.queue, pending: 0, running: 0, failed: 0, dead: 0 };
      if (r.status === 'PENDING') s.pending = r.n; else if (r.status === 'RUNNING') s.running = r.n; else if (r.status === 'FAILED') s.failed = r.n; else if (r.status === 'DEAD') s.dead = r.n;
      m.set(r.queue, s);
    }
    for (const s of m.values()) metrics.queueDepth.set(s.pending, { queue: s.queue });
    return [...m.values()];
  }

  /** Run pending jobs synchronously until the queues are empty (tests / CLI). */
  async drain(handler: JobHandler, queues?: string[], maxJobs = 10_000): Promise<number> {
    let done = 0;
    const qs = queues ?? (await sql<{ queue: string }>`SELECT DISTINCT queue FROM job_queue WHERE status='PENDING'`.execute(this.db)).rows.map((r) => r.queue);
    if (!qs.length) return 0;
    while (done < maxJobs) {
      const jobs = await this.lease(qs, 'drain', 10);
      if (!jobs.length) break;
      for (const job of jobs) {
        try { await handler(job, { heartbeat: async () => {}, workerId: 'drain' }); await this.complete(job); }
        catch (e) { await this.fail(job, sanitizeError(e), e instanceof RetryableJobError ? e.retryInMs : 0); }
        done++;
      }
    }
    return done;
  }
}
