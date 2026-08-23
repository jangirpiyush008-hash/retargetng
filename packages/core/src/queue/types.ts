export interface EnqueueInput {
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  /** de-duplicates while a job with the same key is PENDING/RUNNING */
  idempotencyKey?: string;
  runAt?: Date;
  priority?: number; // lower = sooner
  maxAttempts?: number;
}
export interface Job<T = Record<string, unknown>> {
  id: string;
  queue: string;
  name: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
}
export class RetryableJobError extends Error {
  constructor(message: string, public retryInMs?: number) { super(message); this.name = 'RetryableJobError'; }
}
export type JobHandler = (job: Job, ctx: { heartbeat: () => Promise<void>; workerId: string }) => Promise<void>;

export interface QueueStats { queue: string; pending: number; running: number; failed: number; dead: number }

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<{ id: string; deduplicated: boolean }>;
  /** Start consuming the given queues with `handler`; resolves when started. */
  start(opts: { queues: string[]; concurrency: number; handler: JobHandler; workerId?: string; pollIntervalMs?: number }): Promise<void>;
  stop(): Promise<void>;
  stats(): Promise<QueueStats[]>;
}
