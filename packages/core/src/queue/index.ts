export * from './types.js';
export * from './pg-queue.js';
export * from './bullmq-queue.js';
import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { PgJobQueue } from './pg-queue.js';
import { BullMqJobQueue } from './bullmq-queue.js';
import type { JobQueue } from './types.js';

/** Picks BullMQ when REDIS_URL is configured, else the Postgres queue. */
export function createJobQueue(db: Kysely<DB>, redisUrl = process.env.REDIS_URL): JobQueue {
  return redisUrl ? new BullMqJobQueue(redisUrl) : new PgJobQueue(db);
}
export const QUEUES = {
  events: 'events.process',
  evaluate: 'audience.evaluate',
  sync: 'audience.sync',
  ingest: 'ingest.run',
  maintenance: 'maintenance',
} as const;
