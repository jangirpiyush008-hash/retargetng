import dns from 'node:dns';

export interface ResolvedDatabase {
  url: string;
  /** which environment variable (or combination) it came from — for boot logs and /ready */
  source: string;
  host: string;
  /** Railway private network (*.railway.internal) is IPv6-only */
  privateNetwork: boolean;
}

const clean = (v: string | undefined | null): string | undefined => {
  const s = (v ?? '').trim();
  return s && s !== 'undefined' && s !== 'null' ? s : undefined; // Railway leaves unresolved references as an empty string
};

/**
 * Finds a usable Postgres connection string from the environment. Supports the plain
 * DATABASE_URL, Railway's DATABASE_PUBLIC_URL / reference variables, and the discrete
 * PG_* / POSTGRES_* variables that most providers inject. Empty values (unresolved references)
 * are ignored so the next candidate wins.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): ResolvedDatabase | null {
  const direct: Array<[string, string | undefined]> = [
    ['DATABASE_URL', clean(env.DATABASE_URL)],
    ['DATABASE_PUBLIC_URL', clean(env.DATABASE_PUBLIC_URL)],
    ['POSTGRES_URL', clean(env.POSTGRES_URL)],
    ['POSTGRESQL_URL', clean(env.POSTGRESQL_URL)],
    ['PG_URL', clean(env.PG_URL)],
  ];
  for (const [source, url] of direct) if (url) return describe(url, source);

  const host = clean(env.PGHOST) ?? clean(env.POSTGRES_HOST);
  const user = clean(env.PGUSER) ?? clean(env.POSTGRES_USER) ?? 'postgres';
  const password = clean(env.PGPASSWORD) ?? clean(env.POSTGRES_PASSWORD);
  const database = clean(env.PGDATABASE) ?? clean(env.POSTGRES_DB) ?? 'railway';
  const port = clean(env.PGPORT) ?? clean(env.POSTGRES_PORT) ?? '5432';
  if (host && password) {
    return describe(`postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`, 'PGHOST/PGUSER/PGPASSWORD');
  }
  return null;
}

function describe(url: string, source: string): ResolvedDatabase {
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  return { url, source, host, privateNetwork: host.endsWith('.railway.internal') || host.endsWith('.internal') };
}

let dnsConfigured = false;
/**
 * Railway's private network resolves *.railway.internal over IPv6 only, and takes a few seconds
 * to come up after a container starts. Preferring IPv6 avoids the classic
 * `getaddrinfo ENOTFOUND postgres.railway.internal` on boot.
 */
export function configureDnsFor(resolved: ResolvedDatabase | null): void {
  if (dnsConfigured || !resolved?.privateNetwork) return;
  try { dns.setDefaultResultOrder('ipv6first'); dnsConfigured = true; } catch { /* older node */ }
}

/** Waits until the host resolves (private networking needs a moment after container start). */
export async function waitForDns(resolved: ResolvedDatabase, attempts = 10, delayMs = 2000): Promise<boolean> {
  if (!resolved.host) return true;
  for (let i = 1; i <= attempts; i++) {
    try { await dns.promises.lookup(resolved.host, { all: true }); return true; }
    catch { if (i === attempts) return false; await new Promise((r) => setTimeout(r, delayMs)); }
  }
  return false;
}
