import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';
import { resolveDatabaseUrl, configureDnsFor } from './resolve.js';
import { createEmbeddedDatabase, isEmbeddedPool, type EmbeddedPool } from './embedded.js';

const { Pool, types } = pg;

// Return int8/numeric as JS numbers (ids and money stay far below 2^53 at realistic scales).
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric
types.setTypeParser(1184, (v) => new Date(v)); // timestamptz
// arrays of the above (pg uses separate OIDs/parsers for array types)
const parseNumArray = (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(',').map((x) => (x === 'NULL' ? null : Number(x))));
const setParser = types.setTypeParser as unknown as (oid: number, fn: (v: string) => unknown) => void;
setParser(1016, parseNumArray); // int8[]
setParser(1231, parseNumArray); // numeric[]
setParser(1007, parseNumArray); // int4[]
export const PG_TYPE_PARSERS_READY = true;

export type Database = Kysely<DB>;

export interface CreateDbOptions {
  connectionString?: string;
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
  log?: (event: LogEvent) => void;
}

const poolRegistry = new WeakMap<object, pg.Pool>();

export function createPool(opts: CreateDbOptions = {}): pg.Pool {
  const resolved = opts.connectionString ? null : resolveDatabaseUrl();
  configureDnsFor(resolved);
  const connectionString = opts.connectionString ?? resolved?.url;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  // Managed Postgres (Railway/Supabase/RDS public endpoints) usually needs TLS; sslmode=require / PGSSL=true
  // enables it without CA verification, sslmode=verify-full keeps full verification.
  const sslMode = /[?&]sslmode=([a-z-]+)/.exec(connectionString)?.[1] ?? (process.env.PGSSL === 'true' ? 'require' : undefined);
  const ssl = sslMode === 'verify-full' || sslMode === 'verify-ca' ? true : sslMode && sslMode !== 'disable' ? { rejectUnauthorized: false } : undefined;
  return new Pool({
    connectionString: connectionString.replace(/([?&])sslmode=[a-z-]+&?/, '$1').replace(/[?&]$/, ''),
    ssl,
    max: opts.max ?? Number(process.env.PG_POOL_MAX ?? 10),
    application_name: opts.applicationName ?? 'aap',
    statement_timeout: opts.statementTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(opts: CreateDbOptions = {}): Database {
  return createDbWithPool(opts).db;
}

export function createDbWithPool(opts: CreateDbOptions = {}): { db: Database; pool: pg.Pool } {
  const pool = createPool(opts);
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), log: opts.log });
  poolRegistry.set(db, pool);
  return { db, pool };
}

export type PoolLike = pg.Pool | EmbeddedPool;

/**
 * Preferred entry point for apps: uses the configured Postgres when DATABASE_URL (or an
 * equivalent) is present, otherwise starts the embedded database so the app still runs.
 * Set EMBEDDED_DB=off to make a missing database a hard error instead.
 */
export function createDatabase(opts: CreateDbOptions = {}): { db: Database; pool: PoolLike; embedded: boolean; dataDir?: string } {
  const resolved = opts.connectionString ? { url: opts.connectionString } : resolveDatabaseUrl();
  if (resolved) {
    const { db, pool } = createDbWithPool(opts);
    return { db, pool, embedded: false };
  }
  if ((process.env.EMBEDDED_DB ?? '').toLowerCase() === 'off') throw new Error('DATABASE_URL is not set (EMBEDDED_DB=off)');
  const e = createEmbeddedDatabase();
  poolRegistry.set(e.db, e.pool as unknown as pg.Pool);
  return { db: e.db, pool: e.pool, embedded: true, dataDir: e.dataDir };
}

export { isEmbeddedPool };

export function wrapPool(pool: pg.Pool): Database {
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  poolRegistry.set(db, pool);
  return db;
}

/** The pg Pool behind a Kysely instance created by this module (used by COPY-based seeding). */
export function getPool(db: Database): pg.Pool {
  const p = poolRegistry.get(db);
  if (!p) throw new Error('Pool not registered for this db instance');
  return p;
}
