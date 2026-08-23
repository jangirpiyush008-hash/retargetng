import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@aap/db';
import { EncryptedDbSecretStore, EnvSecretStore, MemorySecretStore, type SecretStore } from './index.js';
import { piiCipher } from '../crypto/pii.js';

/**
 * SECRET_STORE=db (default: AES-GCM encrypted rows in Postgres, key from PII_ENCRYPTION_KEYS)
 *             =env (references resolve to env vars; read-mostly)
 *             =memory (tests)
 * Production deployments should plug in AWS/GCP Secret Manager or Vault behind the same interface.
 */
export function createSecretStore(db: Kysely<DB>, kind = process.env.SECRET_STORE ?? 'db'): SecretStore {
  if (kind === 'memory') return new MemorySecretStore();
  if (kind === 'env') return new EnvSecretStore();
  const cipher = piiCipher();
  return new EncryptedDbSecretStore({
    query: async (q, params = []) => {
      // tiny $n → value binder on top of Kysely's sql template (queries are static strings defined in EncryptedDbSecretStore)
      const parts = q.split(/\$\d+/);
      const frag = sql.join(parts.map((p, i) => (i < params.length ? sql`${sql.raw(p)}${params[i]}` : sql.raw(p))), sql.raw(''));
      const r = await frag.execute(db);
      return { rows: r.rows as Array<Record<string, unknown>> };
    },
    encrypt: (s) => cipher.encrypt(s), decrypt: (b) => cipher.decrypt(b),
  });
}
