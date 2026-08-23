import 'server-only';
import { loadEnv, createDbWithPool, type Database } from '@aap/db';
import { createJobQueue, createSecretStore, DestinationRegistry, AudienceService, DistributionEngine, DestinationService, AuthService, CustomerService, SuppressionService, MeasurementService, DataQualityService, EventIngestor, MembershipEngine, type JobQueue, type SecretStore } from '@aap/core';
import type pg from 'pg';

loadEnv();

/** Process-wide composition root for the web app (HMR-safe via globalThis). */
export interface AppContext {
  db: Database; pool: pg.Pool; queue: JobQueue; secrets: SecretStore; registry: DestinationRegistry;
  auth: AuthService; audiences: AudienceService; distribution: DistributionEngine; destinations: DestinationService; customers: CustomerService;
  suppression: SuppressionService; measurement: MeasurementService; quality: DataQualityService; ingestor: EventIngestor; membership: MembershipEngine;
}
interface Infra { db: Database; pool: pg.Pool; queue: JobQueue; secrets: SecretStore; registry: DestinationRegistry }
const g = globalThis as unknown as { __aapInfra?: Infra };
function infra(): Infra {
  if (g.__aapInfra) return g.__aapInfra;
  const { db, pool } = createDbWithPool({ applicationName: 'aap-web', max: Number(process.env.WEB_PG_POOL ?? 10), statementTimeoutMs: 60_000 });
  g.__aapInfra = { db, pool, queue: createJobQueue(db), secrets: createSecretStore(db), registry: new DestinationRegistry() };
  return g.__aapInfra;
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
