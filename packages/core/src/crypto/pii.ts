import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for raw PII (AES-256-GCM) with a key ring so keys can rotate.
 * Ciphertext layout: [1 byte kid length][kid][12 byte iv][16 byte tag][ciphertext]
 * Keys come from PII_ENCRYPTION_KEYS="kid:hex32,kid2:hex32" (first entry = active key) or a KMS
 * in production (implement KeyProvider).
 */
export interface KeyRing {
  activeKid: string;
  keys: Map<string, Buffer>;
}

export function parseKeyRing(spec: string | undefined = process.env.PII_ENCRYPTION_KEYS): KeyRing {
  if (!spec) throw new Error('PII_ENCRYPTION_KEYS is not configured');
  const entries = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const keys = new Map<string, Buffer>();
  for (const e of entries) {
    const idx = e.indexOf(':');
    if (idx <= 0) throw new Error('PII_ENCRYPTION_KEYS entries must be kid:hex');
    const kid = e.slice(0, idx);
    const key = Buffer.from(e.slice(idx + 1), 'hex');
    if (key.length !== 32) throw new Error(`PII key ${kid} must be 32 bytes (64 hex chars)`);
    keys.set(kid, key);
  }
  const activeKid = entries[0]!.split(':')[0]!;
  return { activeKid, keys };
}

export class PiiCipher {
  constructor(private ring: KeyRing = parseKeyRing()) {}

  encrypt(plaintext: string): Buffer {
    const key = this.ring.keys.get(this.ring.activeKid)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const kid = Buffer.from(this.ring.activeKid, 'utf8');
    return Buffer.concat([Buffer.from([kid.length]), kid, iv, tag, ct]);
  }

  decrypt(blob: Buffer): string {
    const kidLen = blob[0]!;
    const kid = blob.subarray(1, 1 + kidLen).toString('utf8');
    const key = this.ring.keys.get(kid);
    if (!key) throw new Error(`Unknown PII key id ${kid}`);
    let off = 1 + kidLen;
    const iv = blob.subarray(off, off + 12); off += 12;
    const tag = blob.subarray(off, off + 16); off += 16;
    const ct = blob.subarray(off);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** Which key encrypted this blob (for rotation sweeps). */
  kidOf(blob: Buffer): string {
    return blob.subarray(1, 1 + blob[0]!).toString('utf8');
  }
  get activeKid() { return this.ring.activeKid; }
}

let shared: PiiCipher | undefined;
export function piiCipher(): PiiCipher {
  if (!shared) shared = new PiiCipher();
  return shared;
}
