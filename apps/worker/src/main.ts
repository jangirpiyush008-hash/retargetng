import { loadEnv, createDatabase } from '@aap/db';
loadEnv();
import http from 'node:http';
import { sql } from 'kysely';
import { createJobQueue, createSecretStore, DestinationRegistry, WorkerRuntime, metrics, logger, sanitizeError } from '@aap/core';

const log = logger().child({ service: 'worker' });
const { db, pool, embedded, dataDir } = createDatabase({ applicationName: 'aap-worker', max: Number(process.env.WORKER_PG_POOL ?? 12) });
if (embedded) log.warn({ dataDir }, 'no DATABASE_URL configured — using the embedded database (single process; the web app cannot share it)');
const queue = createJobQueue(db);
const registry = new DestinationRegistry();
const runtime = new WorkerRuntime({ db, queue, secrets: createSecretStore(db), registry, name: 'worker' });

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'worker', uptime: process.uptime() })); return; }
    if (req.url === '/ready') {
      await sql`select 1`.execute(db);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, db: 'up', embedded, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } }));
      return;
    }
    if (req.url === '/metrics') {
      metrics.dbPool.set(pool.totalCount, { stat: 'total' }); metrics.dbPool.set(pool.idleCount, { stat: 'idle' });
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(metrics.render()); return;
    }
    if (req.url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(await queue.stats())); return; }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: sanitizeError(e) })); }
});

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 6);
await runtime.start({ concurrency, schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000) });
const port = Number(process.env.PORT ?? process.env.WORKER_PORT ?? 9464);
server.listen(port, () => log.info({ port, concurrency, destinationMode: registry.currentMode, embedded }, 'worker started'));

async function shutdown(sig: string) {
  log.info({ sig }, 'shutting down');
  server.close();
  await runtime.stop();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
