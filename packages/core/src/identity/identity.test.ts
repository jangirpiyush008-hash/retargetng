import { describe, it, expect } from 'vitest';
import { normalizeEmail, normalizePhone, hashIdentifiers, emailHash } from './normalize.js';
import { sha256Hex } from '../crypto/hash.js';

describe('normalizeEmail', () => {
  it('lowercases and strips whitespace', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')?.normalized).toBe('john.doe@example.com');
  });
  it('applies Google gmail normalization (dots + plus) only for gmail/googlemail', () => {
    const g = normalizeEmail('John.Doe+promo@Gmail.com')!;
    expect(g.normalized).toBe('john.doe+promo@gmail.com'); // canonical/Meta keeps dots
    expect(g.google).toBe('johndoe@gmail.com');
    const o = normalizeEmail('john.doe+promo@outlook.com')!;
    expect(o.google).toBe('john.doe+promo@outlook.com');
  });
  it('flags invalid format', () => {
    expect(normalizeEmail('not-an-email')?.valid).toBe(false);
    expect(normalizeEmail('')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('normalizes to E.164 using default country', () => {
    const p = normalizePhone('98765 43210', 'IN')!;
    expect(p.e164).toBe('+919876543210');
    expect(p.digits).toBe('919876543210');
    expect(p.valid).toBe(true);
  });
  it('keeps explicit country code', () => {
    expect(normalizePhone('+1 (415) 555-2671', 'IN')!.e164).toBe('+14155552671');
  });
  it('returns deterministic but invalid for junk', () => {
    const p = normalizePhone('12', 'IN')!;
    expect(p.valid).toBe(false);
  });
});

describe('hashIdentifiers', () => {
  it('produces deterministic SHA-256 per profile', () => {
    const h = hashIdentifiers({ email: 'A.B+c@gmail.com', phone: '9876543210', country: 'IN' });
    expect(h.email!.hashes.EMAIL_SHA256.toString('hex')).toBe(sha256Hex('a.b+c@gmail.com'));
    expect(h.email!.hashes.EMAIL_SHA256_GOOGLE.toString('hex')).toBe(sha256Hex('ab@gmail.com'));
    expect(h.phone!.hashes.PHONE_E164_SHA256.toString('hex')).toBe(sha256Hex('+919876543210'));
    expect(h.phone!.hashes.PHONE_DIGITS_SHA256.toString('hex')).toBe(sha256Hex('919876543210'));
    expect(emailHash('a.b+c@GMAIL.com')!.equals(h.email!.hashes.EMAIL_SHA256)).toBe(true);
  });
  it('customer changing email yields a different canonical hash', () => {
    const a = hashIdentifiers({ email: 'one@example.com' });
    const b = hashIdentifiers({ email: 'two@example.com' });
    expect(a.email!.hashes.EMAIL_SHA256.equals(b.email!.hashes.EMAIL_SHA256)).toBe(false);
  });
});
