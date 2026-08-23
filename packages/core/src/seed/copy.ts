import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

/**
 * Buffers encoded COPY lines per table and flushes them with `COPY ... FROM STDIN` (text format).
 * One COPY runs at a time per connection, so buffers are flushed sequentially per chunk.
 */
export class TableBuffer {
  private lines: string[] = [];
  rows = 0;
  constructor(public table: string, public columns: string[]) {}
  write(values: unknown[]): void { this.lines.push(values.map(encode).join('\t') + '\n'); this.rows++; }
  get size() { return this.lines.length; }
  async flush(client: pg.PoolClient): Promise<number> {
    if (!this.lines.length) return 0;
    const stream = client.query(copyFrom(`COPY ${this.table} (${this.columns.join(', ')}) FROM STDIN`)) as unknown as NodeJS.WritableStream;
    const done = new Promise<void>((resolve, reject) => { stream.on('finish', () => resolve()); stream.on('error', reject); });
    const CH = 4096;
    for (let i = 0; i < this.lines.length; i += CH) {
      const chunk = this.lines.slice(i, i + CH).join('');
      if (!stream.write(chunk)) await new Promise<void>((r) => stream.once('drain', () => r()));
    }
    stream.end();
    await done;
    const n = this.lines.length; this.lines = [];
    return n;
  }
}

export function encode(v: unknown): string {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '\\N';
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\\\x' + v.toString('hex');
  if (Array.isArray(v)) return '{' + v.map((x) => (typeof x === 'string' ? '"' + x.replace(/(["\\])/g, '\\$1') + '"' : encode(x))).join(',') + '}';
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(String(v));
}
function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r'); }
