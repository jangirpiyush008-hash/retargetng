import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads .env from cwd, then from the repository root (monorepo packages run from subdirs). */
export function loadEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) dotenv.config({ path: p, override: false });
  }
}
