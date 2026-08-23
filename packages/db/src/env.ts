import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads .env from cwd, then from the repository root (monorepo packages run from subdirs).
 * Skipped in production, where configuration comes from the platform's environment
 * (set LOAD_DOTENV=1 to override, e.g. for a self-hosted container using a mounted .env).
 */
export function loadEnv(): void {
  if (process.env.NODE_ENV === 'production' && process.env.LOAD_DOTENV !== '1') return;
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) dotenv.config({ path: p, override: false });
  }
}
