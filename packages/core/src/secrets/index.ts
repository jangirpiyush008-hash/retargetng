/**
 * SecretStore — destination credentials are referenced, never stored in the database.
 * References look like `secret://meta/<destinationId>/access_token`.
 * Production: implement with AWS Secrets Manager / GCP Secret Manager / Vault.
 */
export interface SecretStore {
  get(ref: string): Promise<string | null>;
  put(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(ref: string) { return this.m.get(ref) ?? null; }
  async put(ref: string, value: string) { this.m.set(ref, value); }
  async delete(ref: string) { this.m.delete(ref); }
}

/**
 * Env-backed store for local development: `secret://a/b/c` ⇄ env var `SECRET__A__B__C`.
 * put() is supported in-process only (so "Connect" flows work locally) and warns.
 */
export class EnvSecretStore implements SecretStore {
  private overlay = new Map<string, string>();
  private envName(ref: string) {
    return 'SECRET__' + ref.replace(/^secret:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '__').toUpperCase();
  }
  async get(ref: string) {
    return this.overlay.get(ref) ?? process.env[this.envName(ref)] ?? null;
  }
  async put(ref: string, value: string) {
    this.overlay.set(ref, value);
  }
  async delete(ref: string) { this.overlay.delete(ref); }
}

/**
 * Database-backed encrypted store (AES-GCM with the PII key ring). Acceptable for
 * self-hosted deployments where a dedicated secret manager is not available; the
 * ciphertext lives in table `secrets` created lazily. Prefer a managed secret manager.
 */
export class EncryptedDbSecretStore implements SecretStore {
  constructor(private deps: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; encrypt: (s: string) => Buffer; decrypt: (b: Buffer) => string }) {}
  private ready = false;
  private async ensure() {
    if (this.ready) return;
    await this.deps.query(`CREATE TABLE IF NOT EXISTS secrets (ref text PRIMARY KEY, ciphertext bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    this.ready = true;
  }
  async get(ref: string) {
    await this.ensure();
    const { rows } = await this.deps.query('SELECT ciphertext FROM secrets WHERE ref = $1', [ref]);
    const row = rows[0];
    return row ? this.deps.decrypt(row.ciphertext as Buffer) : null;
  }
  async put(ref: string, value: string) {
    await this.ensure();
    await this.deps.query(
      'INSERT INTO secrets (ref, ciphertext) VALUES ($1,$2) ON CONFLICT (ref) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()',
      [ref, this.deps.encrypt(value)],
    );
  }
  async delete(ref: string) {
    await this.ensure();
    await this.deps.query('DELETE FROM secrets WHERE ref = $1', [ref]);
  }
}

export function secretRef(parts: string[]): string {
  return 'secret://' + parts.map((p) => p.replace(/[^a-zA-Z0-9_-]/g, '_')).join('/');
}
export { createSecretStore } from './factory.js';
