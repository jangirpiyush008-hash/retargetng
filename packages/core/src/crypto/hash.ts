import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}
export function sha256Hex(input: string | Buffer): string {
  return sha256(input).toString('hex');
}
export function hmacSha256Hex(key: string, input: string): string {
  return createHmac('sha256', key).update(input).digest('hex');
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Stable JSON stringify (sorted keys) for payload hashing / idempotency. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
