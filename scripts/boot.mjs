#!/usr/bin/env node
// Production boot for Railway/containers:  node scripts/boot.mjs web|worker
//  1. env sanity report (values masked)   2. migrations with retries   3. start the app (fail-soft so health endpoints can report problems)
import { spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const role = process.argv[2] ?? 'web';
// local convenience: load repo-root .env (platform env vars always win)
const envFile = path.join(root, '.env');
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const log = (m) => console.log(`[boot:${role}] ${m}`);
const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-4) + ` (${v.length} chars)` : 'MISSING');

log(`node ${process.version} · NODE_ENV=${process.env.NODE_ENV ?? 'unset'} · PORT=${process.env.PORT ?? 'unset'}`);

// ---- database discovery: DATABASE_URL, then Railway's public URL, then discrete PG*/POSTGRES* vars.
// Unresolved Railway references arrive as empty strings, so blanks are skipped rather than trusted.
const clean = (v) => { const t = (v ?? '').trim(); return t && t !== 'undefined' && t !== 'null' ? t : undefined; };
const candidates = [
  ['DATABASE_URL', clean(process.env.DATABASE_URL)],
  ['DATABASE_PUBLIC_URL', clean(process.env.DATABASE_PUBLIC_URL)],
  ['POSTGRES_URL', clean(process.env.POSTGRES_URL)],
];
let dbUrl = candidates.find(([, v]) => v);
if (!dbUrl) {
  const host = clean(process.env.PGHOST) ?? clean(process.env.POSTGRES_HOST);
  const pass = clean(process.env.PGPASSWORD) ?? clean(process.env.POSTGRES_PASSWORD);
  if (host && pass) {
    const user = clean(process.env.PGUSER) ?? clean(process.env.POSTGRES_USER) ?? 'postgres';
    const port = clean(process.env.PGPORT) ?? clean(process.env.POSTGRES_PORT) ?? '5432';
    const name = clean(process.env.PGDATABASE) ?? clean(process.env.POSTGRES_DB) ?? 'railway';
    dbUrl = ['PGHOST/PGUSER/PGPASSWORD', `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${name}`];
  }
}
let dbHost = '';
if (dbUrl) {
  process.env.DATABASE_URL = dbUrl[1]; // normalise for every child process
  try { dbHost = new URL(dbUrl[1]).hostname; } catch { dbHost = '(unparseable URL)'; }
  log(`database: ${dbHost} (from ${dbUrl[0]})`);
} else {
  const seen = Object.keys(process.env).filter((k) => /^(DATABASE|POSTGRES|PG)[_A-Z]*$/.test(k));
  log(`DATABASE_URL: MISSING — no usable database variable. Present-but-empty/unusable: ${seen.length ? seen.join(', ') : 'none'}`);
  log('  → In Railway: add a PostgreSQL database, then set DATABASE_URL on THIS service.');
  log('  → If the reference shows "<empty string>", the database service has a different name:');
  log('     open the Postgres service → Variables → copy the DATABASE_URL value and paste it here literally.');
}
// Railway private networking (*.railway.internal) is IPv6-only and needs a few seconds after boot.
const privateNet = dbHost.endsWith('.railway.internal') || dbHost.endsWith('.internal');
if (privateNet) {
  try { dns.setDefaultResultOrder('ipv6first'); } catch { /* older node */ }
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --dns-result-order=ipv6first`.trim();
  log('private network detected → IPv6-first DNS enabled for this process and its children');
}
if (dbHost) {
  for (let i = 1; i <= 15; i++) {
    try { await dns.promises.lookup(dbHost, { all: true }); if (i > 1) log(`database host resolved after ${i} attempt(s)`); break; }
    catch (e) {
      if (i === 15) { log(`WARNING: ${dbHost} does not resolve (${e.code}). ${privateNet ? 'Private networking may be disabled or the database is in another environment — use the public URL instead (Postgres → Settings → Networking → TCP Proxy, then DATABASE_PUBLIC_URL).' : 'Check the host in DATABASE_URL.'}`); break; }
      if (i === 1) log(`waiting for ${dbHost} to resolve…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
log(`PII_ENCRYPTION_KEYS: ${mask(process.env.PII_ENCRYPTION_KEYS)}${process.env.PII_ENCRYPTION_KEYS ? '' : ' — set to v1:<64 hex chars> (openssl rand -hex 32)'}`);
log(`SESSION_SECRET: ${mask(process.env.SESSION_SECRET)} · DESTINATION_MODE=${process.env.DESTINATION_MODE ?? 'mock'} · SECRET_STORE=${process.env.SECRET_STORE ?? 'db'} · REDIS_URL=${process.env.REDIS_URL ? 'set' : 'unset'}`);

const hasPnpm = spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0;
const bin = (pkgDir, name) => { const p = path.join(root, pkgDir, 'node_modules', '.bin', name); return existsSync(p) ? p : path.join(root, 'node_modules', '.bin', name); };

async function migrate() {
  if (!process.env.DATABASE_URL) { log('skipping migrations (no DATABASE_URL)'); return false; }
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = hasPnpm ? spawnSync('pnpm', ['--filter', '@aap/db', 'migrate'], { stdio: 'inherit', cwd: root, env: process.env })
                      : spawnSync(bin('packages/db', 'tsx'), ['src/cli.ts', 'migrate'], { stdio: 'inherit', cwd: path.join(root, 'packages/db'), env: process.env });
    if (r.status === 0) { log('migrations up to date'); return true; }
    log(`migration attempt ${attempt}/12 failed (database not reachable yet?) — retrying in 5s`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  log('WARNING: migrations did not succeed; starting anyway so /ready can report the problem');
  return false;
}

function start() {
  let cmd, args, cwd;
  if (role === 'worker') { cmd = bin('apps/worker', 'tsx'); args = ['src/main.ts']; cwd = path.join(root, 'apps/worker'); }
  else { cmd = bin('apps/web', 'next'); args = ['start']; cwd = path.join(root, 'apps/web'); }
  log(`starting ${role}: ${path.basename(cmd)} ${args.join(' ')} (cwd ${path.relative(root, cwd)})`);
  const child = spawn(cmd, args, { stdio: 'inherit', cwd, env: process.env });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => { log(`${role} exited code=${code} signal=${signal}`); process.exit(code ?? 1); });
}

const migrated = await migrate();
if (migrated) {
  const coreTsx = bin('packages/core', 'tsx'); const coreDir = path.join(root, 'packages/core');
  // First admin from env (idempotent)
  if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    const r = spawnSync(coreTsx, ['src/seed/cli.ts', '--bootstrap'], { stdio: 'inherit', cwd: coreDir, env: process.env });
    if (r.status !== 0) log('WARNING: bootstrap admin failed (see above)');
  }
  // Optional demo dataset on first boot (web role only; runs in the background so the service becomes healthy immediately)
  const demo = (process.env.DEMO_SEED ?? '').toLowerCase();
  if (role === 'web' && (demo === 'quick' || demo === 'full')) {
    const args = ['src/seed/cli.ts', '--if-empty', ...(demo === 'quick' ? ['--quick'] : [])];
    log(`DEMO_SEED=${demo}: seeding demo organization in the background (skipped if it already exists)`);
    const child = spawn(coreTsx, args, { stdio: 'inherit', cwd: coreDir, env: process.env, detached: false });
    child.on('exit', (code) => log(`demo seed finished with code ${code}`));
  }
}
start();
