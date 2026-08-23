import { from as copyFrom } from 'pg-copy-streams';

/** Client shape both a real pg client and the embedded pool expose. */
export interface SeedClient {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
}

export type SeedMode = 'copy' | 'insert';

/**
 * Buffers rows for one table and writes them with `COPY ... FROM STDIN` (fast path for a real
 * Postgres connection) or batched multi-row INSERTs (embedded database, which has no COPY stream).
 */
export class TableBuffer {
  private lines: string[] = [];
  private values: unknown[][] = [];
  rows = 0;
  constructor(public table: string, public columns: string[], private mode: SeedMode = 'copy') {}

  write(values: unknown[]): void {
    if (this.mode === 'copy') this.lines.push(values.map(encode).join('\t') + '\n');
    else this.values.push(values);
    this.rows++;
  }
  get size(): number { return this.mode === 'copy' ? this.lines.length : this.values.length; }

  async flush(client: SeedClient): Promise<number> {
    return this.mode === 'copy' ? this.flushCopy(client) : this.flushInsert(client);
  }

  private async flushCopy(client: SeedClient): Promise<number> {
    if (!this.lines.length) return 0;
    const stream = (client as { query: (q: unknown) => unknown }).query(
      copyFrom(`COPY ${this.table} (${this.columns.join(', ')}) FROM STDIN`),
    ) as unknown as NodeJS.WritableStream;
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

  /**
   * Multi-row INSERTs, chunked to stay well under Postgres' 65535 bound parameters per statement.
   * COPY may write GENERATED ALWAYS identity columns directly; INSERT needs OVERRIDING SYSTEM VALUE.
   */
  private async flushInsert(client: SeedClient): Promise<number> {
    if (!this.values.length) return 0;
    const overriding = this.columns.includes('id') ? ' OVERRIDING SYSTEM VALUE' : '';
    const cols = this.columns.length;
    const perStatement = Math.max(1, Math.floor(20_000 / cols));
    const total = this.values.length;
    for (let i = 0; i < total; i += perStatement) {
      const slice = this.values.slice(i, i + perStatement);
      const params: unknown[] = [];
      const tuples = slice.map((row) => {
        const placeholders = row.map((v) => { params.push(toParam(v)); return `$${params.length}`; });
        return `(${placeholders.join(',')})`;
      });
      await client.query(`INSERT INTO ${this.table} (${this.columns.join(', ')})${overriding} VALUES ${tuples.join(',')}`, params);
    }
    this.values = [];
    return total;
  }
}

/** jsonb columns need a string; Buffers/Dates/arrays pass through as native parameters. */
function toParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return v;
  if (Buffer.isBuffer(v) || v instanceof Date || Array.isArray(v)) return v;
  return JSON.stringify(v);
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
