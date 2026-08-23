import 'server-only';
import { loadEnv, createDatabase, type Database, type PoolLike } from '@aap/db';
import { createJobQueue, createSecretStore, DestinationRegistry, AudienceService, DistributionEngine, DestinationService, AuthService, CustomerService, SuppressionService, MeasurementService, DataQualityService, EventIngestor, MembershipEngine, type JobQueue, type SecretStore } from '@aap/core';

loadEnv();

/** Process-wide composition root for the web app (HMR-safe via globalThis). */
export interface AppContext {
  db: Database; pool: PoolLike; embedded: boolean; dataDir?: string; queue: JobQueue; secrets: SecretStore; registry: DestinationRegistry;
  auth: AuthService; audiences: AudienceService; distribution: DistributionEngine; destinations: DestinationService; customers: CustomerService;
  suppression: SuppressionService; measurement: MeasurementService; quality: DataQualityService; ingestor: EventIngestor; membership: MembershipEngine;
}
interface Infra { db: Database; pool: PoolLike; embedded: boolean; dataDir?: string; queue: JobQueue; secrets: SecretStore; registry: DestinationRegistry }
const g = globalThis as unknown as { __aapInfra?: Infra };
function infra(): Infra {
  if (g.__aapInfra) return g.__aapInfra;
  const { db, pool, embedded, dataDir } = createDatabase({ applicationName: 'aap-web', max: Number(process.env.WEB_PG_POOL ?? 10), statementTimeoutMs: 60_000 });
  g.__aapInfra = { db, pool, embedded, dataDir, queue: createJobQueue(db), secrets: createSecretStore(db), registry: new DestinationRegistry() };
  return g.__aapInfra;
}
/**
 * Ensures the app can serve requests: on the embedded database this prepares the schema, seeds the
 * demo data and starts the in-process background engine (once per process). No-op otherwise.
 */
export async function ready(): Promise<void> {
  if (!infra().embedded) return;
  const { startEmbeddedRuntime } = await import('./embedded-worker');
  await startEmbeddedRuntime();
}

/**
 * Infrastructure (pool, queue, secret store, registry) is a process singleton; services are thin
 * stateless wrappers constructed per call so dev hot-reloads never serve stale class instances.
 */
export function ctx(): AppContext {
  const i = infra();
  const { db, queue, secrets, registry } = i;
  return {
    ...i,
    auth: new AuthService(db), audiences: new AudienceService(db, queue), distribution: new DistributionEngine({ db, queue, secrets, registry }),
    destinations: new DestinationService(db, secrets, registry), customers: new CustomerService(db), suppression: new SuppressionService(db),
    measurement: new MeasurementService(db), quality: new DataQualityService(db), ingestor: new EventIngestor(db, queue), membership: new MembershipEngine(db),
  };
}
