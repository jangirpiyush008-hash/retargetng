import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

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
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Pool({
    connectionString,
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
