import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';
import { migrate, resetSchema } from './migrate.js';
import './client.js'; // registers the same pg type parsers used in production

export interface TestDb {
  db: Kysely<DB>;
  pool: pg.Pool;
  close(): Promise<void>;
  /** Truncates all domain tables (fast between tests). */
  truncateAll(): Promise<void>;
}

let cachedSchemaReady = false;

/**
 * Connects to TEST_DATABASE_URL, (re)creates the schema once per process and returns a handle.
 */
export async function createTestDb(opts: { fresh?: boolean } = {}): Promise<TestDb> {
  const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://aap:aap@localhost:5432/aap_test';
  const pool = new pg.Pool({ connectionString, max: 6, application_name: 'aap-test' });
  if (!cachedSchemaReady || opts.fresh) {
    await resetSchema(pool);
    await migrate(pool);
    cachedSchemaReady = true;
  }
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    async close() {
      await db.destroy();
    },
    async truncateAll() {
      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations')
           AND tablename NOT LIKE '%\\_default' AND tablename !~ '_[0-9]{6}$'`,
      );
      const names = rows.map((r) => `"${r.tablename}"`).join(', ');
      if (names) await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    },
  };
}
