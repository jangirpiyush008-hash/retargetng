import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Minimal, transparent SQL migrator. Each *.sql file in packages/db/migrations runs once,
 * inside a transaction, recorded in schema_migrations. Files are applied in lexical order
 * (0001_..., 0002_...). Never edits applied files — add a new file instead.
 */
/** Anything exposing pg's connect()/query() shape — a real pg.Pool or the embedded pool. */
export interface MigratorPool {
  connect(): Promise<{ query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; release: () => void }>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function migrate(pool: MigratorPool, opts: { dir?: string; log?: (m: string) => void } = {}): Promise<MigrationResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)`);
    // serialize concurrent migrators
    await client.query('SELECT pg_advisory_lock(727272)');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = (await client.query('SELECT name, checksum FROM schema_migrations')) as { rows: Array<{ name: string; checksum: string }> };
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = await sha256Hex(sql);
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(727272)');
  } finally {
    client.release();
  }
  return result;
}

/** Drops and recreates the public schema — destructive; used by tests and `db:reset`. */
export async function resetSchema(pool: MigratorPool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex');
}
