export * from './time.js';
export class NotFoundError extends Error { status = 404; constructor(msg = 'Not found') { super(msg); this.name = 'NotFoundError'; } }
export class ValidationError extends Error { status = 400; details?: unknown; constructor(msg: string, details?: unknown) { super(msg); this.name = 'ValidationError'; this.details = details; } }
export class ConflictError extends Error { status = 409; constructor(msg: string) { super(msg); this.name = 'ConflictError'; } }
export function slugify(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'AUDIENCE';
}
export function pct(num: number, den: number): number | null { return den > 0 ? Math.round((num / den) * 10000) / 100 : null; }
