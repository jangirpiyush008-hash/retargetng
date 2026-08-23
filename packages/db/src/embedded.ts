/**
 * Embedded PostgreSQL (PGlite — real Postgres compiled to WASM, running in-process).
 *
 * Used when no external database is configured, so the app boots and works anywhere with zero
 * infrastructure: the same migrations, the same SQL engine, the same domain code. Intended for
 * demos, previews and local development — a single process owns the data directory, and the data
 * lives only as long as that directory does. Point DATABASE_URL at a managed Postgres for
 * production (multi-process, backups, connection pooling).
 */
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type Dialect,
  type QueryResult,
} from 'kysely';
import type { DB } from './types.js';

type PGliteInstance = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec: (sql: string) => Promise<Array<{ rows: unknown[]; affectedRows?: number }>>;
  close: () => Promise<void>;
  waitReady: Promise<unknown>;
};

/** Matches the pg type parsing used for real connections (see client.ts). */
const PARSERS: Record<number, (v: string) => unknown> = {
  20: (v) => Number(v), // int8
  1700: (v) => Number(v), // numeric
  17: (v) => Buffer.from(v.slice(2), 'hex'), // bytea → Buffer (identifier hashes rely on Buffer APIs)
  1016: (v) => v.slice(1, -1).split(',').filter(Boolean).map(Number), // int8[]
  1231: (v) => v.slice(1, -1).split(',').filter(Boolean).map(Number), // numeric[]
};

/** Serializes access so Kysely transactions cannot interleave on PGlite's single connection. */
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;
  async acquire(timeoutMs = 120_000): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((f) => f !== grant);
        reject(new Error('embedded database: timed out waiting for a connection'));
      }, timeoutMs);
      this.queue.push(grant);
    });
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

type PGlitePromise = Promise<PGliteInstance>;

class PGliteConnection implements DatabaseConnection {
  constructor(private get: () => PGlitePromise) {}
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const pg = await this.get();
    const params = compiled.parameters as unknown[];
    const res = params.length
      ? await pg.query(compiled.sql, params)
      : ((await pg.exec(compiled.sql)).at(-1) ?? { rows: [], affectedRows: 0 });
    return { rows: (res.rows ?? []) as R[], numAffectedRows: BigInt(res.affectedRows ?? 0) };
  }
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not supported by the embedded database');
    yield undefined as never;
  }
}

class PGliteDriver implements Driver {
  private mutex = new Mutex();
  private connection: PGliteConnection;
  constructor(private get: () => PGlitePromise) {
    this.connection = new PGliteConnection(get);
  }
  async init(): Promise<void> {
    await this.get();
  }
  async acquireConnection(): Promise<DatabaseConnection> {
    await this.mutex.acquire();
    return this.connection;
  }
  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('begin'));
  }
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('commit'));
  }
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('rollback'));
  }
  async releaseConnection(): Promise<void> {
    this.mutex.release();
  }
  async destroy(): Promise<void> {
    (await this.get()).close();
  }
}

class PGliteDialect implements Dialect {
  constructor(private get: () => PGlitePromise) {}
  createAdapter() {
    return new PostgresAdapter();
  }
  createDriver() {
    return new PGliteDriver(this.get);
  }
  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<DB>) {
    return new PostgresIntrospector(db);
  }
}

/** Minimal `pg.Pool`-compatible surface: enough for the migrator, seeder and health endpoints. */
export interface EmbeddedPool {
  readonly embedded: true;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  connect(): Promise<{ query: EmbeddedPool['query']; release: () => void }>;
  end(): Promise<void>;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export function isEmbeddedPool(pool: unknown): pool is EmbeddedPool {
  return !!pool && typeof pool === 'object' && (pool as { embedded?: boolean }).embedded === true;
}

export interface EmbeddedDatabase {
  db: Kysely<DB>;
  pool: EmbeddedPool;
  dataDir: string;
}

/**
 * Creates the embedded database handle. The PGlite instance starts lazily on first use, so this
 * stays synchronous and can be called from an app's composition root.
 * `dataDir` defaults to EMBEDDED_DB_DIR or ./.pgdata-embedded; use "memory://"
 * (or EMBEDDED_DB=memory) for a throwaway in-memory instance.
 */
export function createEmbeddedDatabase(opts: { dataDir?: string } = {}): EmbeddedDatabase {
  const dataDir =
    opts.dataDir ??
    (process.env.EMBEDDED_DB === 'memory' ? 'memory://' : (process.env.EMBEDDED_DB_DIR ?? './.pgdata-embedded'));

  let started: Promise<PGliteInstance> | undefined;
  const get = (): Promise<PGliteInstance> => {
    started ??= (async () => {
      // Loaded through Node's own loader: bundlers (Next.js) must not inline PGlite's WASM/runtime.
      const load = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, never>>;
      const { PGlite } = (await load('@electric-sql/pglite')) as unknown as { PGlite: new (dir: string, opts: unknown) => unknown };
      const { pgcrypto } = (await load('@electric-sql/pglite/contrib/pgcrypto')) as unknown as { pgcrypto: unknown };
      const pg = new PGlite(dataDir, { extensions: { pgcrypto }, parsers: PARSERS }) as unknown as PGliteInstance;
      await pg.waitReady;
      return pg;
    })();
    return started;
  };

  const query: EmbeddedPool['query'] = async (text, params) => {
    const pg = await get();
    const res = params?.length
      ? await pg.query(text, params)
      : ((await pg.exec(text)).at(-1) ?? { rows: [], affectedRows: 0 });
    const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
    return { rows, rowCount: res.affectedRows ?? rows.length };
  };
  const pool: EmbeddedPool = {
    embedded: true,
    query,
    async connect() {
      return { query, release: () => {} };
    },
    async end() {
      if (started) (await started).close();
    },
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  const db = new Kysely<DB>({ dialect: new PGliteDialect(get) });
  return { db, pool, dataDir };
}
