/** Deterministic PRNG (mulberry32) so demo data is reproducible. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number { let t = (this.s += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
  /** weighted pick: [[value, weight], ...] */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T { const total = entries.reduce((s, e) => s + e[1], 0); let r = this.next() * total; for (const [v, w] of entries) { r -= w; if (r <= 0) return v; } return entries[entries.length - 1]![0]; }
  lognormal(mu: number, sigma: number): number { const u = 1 - this.next(), v = this.next(); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); return Math.exp(mu + sigma * z); }
  geometric(p: number, max = 50): number { let n = 1; while (this.next() > p && n < max) n++; return n; }
  date(from: Date, to: Date): Date { return new Date(from.getTime() + this.next() * (to.getTime() - from.getTime())); }
}
