import type { EnqueueInput, Job, JobHandler, JobQueue, QueueStats } from './types.js';
import { RetryableJobError } from './types.js';
import { sanitizeError } from '../observability/logger.js';

/**
 * BullMQ/Redis implementation of JobQueue. Loaded lazily so Redis is optional.
 * Enabled by REDIS_URL. Each logical queue maps to a BullMQ Queue of the same name.
 */
export class BullMqJobQueue implements JobQueue {
  private queues = new Map<string, import('bullmq').Queue>();
  private workers: import('bullmq').Worker[] = [];
  private bull?: typeof import('bullmq');
  private connection: { url: string };
  constructor(redisUrl: string) { this.connection = { url: redisUrl }; }

  private async lib() { if (!this.bull) this.bull = await import('bullmq'); return this.bull; }
  private async q(name: string) {
    const { Queue } = await this.lib();
    let q = this.queues.get(name);
    if (!q) { q = new Queue(name, { connection: this.connection as never }); this.queues.set(name, q); }
    return q;
  }
  async enqueue(input: EnqueueInput) {
    const q = await this.q(input.queue);
    const job = await q.add(input.name, input.payload, {
      jobId: input.idempotencyKey, delay: input.runAt ? Math.max(0, input.runAt.getTime() - Date.now()) : 0,
      priority: input.priority ?? 100, attempts: input.maxAttempts ?? 5, backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000, removeOnFail: 5000,
    });
    return { id: String(job.id), deduplicated: false };
  }
  async start(opts: { queues: string[]; concurrency: number; handler: JobHandler; workerId?: string }) {
    const { Worker, UnrecoverableError } = await this.lib();
    for (const name of opts.queues) {
      const w = new Worker(name, async (bj) => {
        const job: Job = { id: String(bj.id), queue: name, name: bj.name, payload: bj.data, attempts: bj.attemptsMade + 1, maxAttempts: bj.opts.attempts ?? 5 };
        try { await opts.handler(job, { heartbeat: async () => { await bj.updateProgress(1); }, workerId: opts.workerId ?? 'bullmq' }); }
        catch (e) { if (e instanceof RetryableJobError) throw e; throw new UnrecoverableError(sanitizeError(e)); }
      }, { connection: this.connection as never, concurrency: opts.concurrency });
      this.workers.push(w);
    }
  }
  async stop() { await Promise.all(this.workers.map((w) => w.close())); await Promise.all([...this.queues.values()].map((q) => q.close())); }
  async stats(): Promise<QueueStats[]> {
    const out: QueueStats[] = [];
    for (const [name, q] of this.queues) { const c = await q.getJobCounts('waiting', 'delayed', 'active', 'failed'); out.push({ queue: name, pending: (c.waiting ?? 0) + (c.delayed ?? 0), running: c.active ?? 0, failed: c.failed ?? 0, dead: 0 }); }
    return out;
  }
}
