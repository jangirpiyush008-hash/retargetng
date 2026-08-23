import 'server-only';
import { migrate } from '@aap/db';
import { WorkerRuntime, logger } from '@aap/core';
import { ctx } from './context';

/**
 * When the app runs on the embedded database there is no separate worker container, so the web
 * process owns the background engine too: migrations, an optional demo seed, then queue consumers
 * and the scheduler. One container is then a complete, working system.
 */
const g = globalThis as unknown as { __aapEmbeddedWorker?: Promise<void> };

export function startEmbeddedRuntime(): Promise<void> {
  g.__aapEmbeddedWorker ??= (async () => {
    const c = ctx();
    const log = logger().child({ service: 'web-embedded' });
    if (!c.embedded) return;
    log.info({ dataDir: c.dataDir }, 'embedded database: preparing schema');
    await migrate(c.pool as never);
    const seed = (process.env.DEMO_SEED ?? 'tiny').toLowerCase();
    if (seed !== 'off') {
      const existing = await c.db.selectFrom('organizations').select('id').limit(1).executeTakeFirst();
      if (!existing) {
        const { seedDemo } = await import('@aap/core/seed');
        const size = seed === 'full' ? { customers: 1_000_000, events: 10_000_000 } : seed === 'quick' ? { customers: 50_000, events: 500_000 } : { customers: 2_000, events: 20_000 };
        log.info({ ...size }, 'embedded database: seeding demo organization');
        await seedDemo(c.db, c.pool as never, { ...size, seed: 42, log: (m, extra) => log.info(extra ?? {}, m) });
      }
    }
    const runtime = new WorkerRuntime({ db: c.db, queue: c.queue, secrets: c.secrets, registry: c.registry, name: 'web-embedded' });
    await runtime.start({ concurrency: 2, schedulerIntervalMs: 60_000 });
    log.info('embedded background engine started (evaluations, syncs and maintenance run in this process)');
  })().catch((e) => {
    logger().error({ err: (e as Error).message }, 'embedded runtime failed to start');
    g.__aapEmbeddedWorker = undefined;
  });
  return g.__aapEmbeddedWorker;
}
