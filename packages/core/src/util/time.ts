export const SECONDS = { minutes: 60, hours: 3600, days: 86400, weeks: 604800 } as const;
export type TimeUnit = keyof typeof SECONDS;
export function toSeconds(value: number, unit: TimeUnit): number { return value * SECONDS[unit]; }
export function addSeconds(d: Date, s: number): Date { return new Date(d.getTime() + s * 1000); }
export function daysAgo(d: Date, days: number): Date { return addSeconds(d, -days * 86400); }
export function startOfUtcDay(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
export function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
export function scheduleIntervalSeconds(s: string): number | null {
  switch (s) {
    case 'REALTIME': return 5 * 60; // evaluated at least every 5 minutes, plus on event bursts
    case 'HOURLY': return 3600;
    case 'EVERY_6_HOURS': return 6 * 3600;
    case 'DAILY': return 86400;
    default: return null; // MANUAL
  }
}
export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
/** Exponential backoff with full jitter. */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 5 * 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exp);
}
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
