import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { sha256 } from '../crypto/hash.js';

/**
 * Hash profiles: the platform stores, per customer, a SHA-256 per (identifier kind, profile).
 * Activation uses ONLY these hashes. Each destination declares which profiles it consumes.
 */
export const HASH_PROFILES = {
  EMAIL_SHA256: 'EMAIL_SHA256', // lower + trim  (Meta, generic)
  EMAIL_SHA256_GOOGLE: 'EMAIL_SHA256_GOOGLE', // lower + trim + gmail dot/plus removal (Google)
  PHONE_E164_SHA256: 'PHONE_E164_SHA256', // +14155551212 (Google)
  PHONE_DIGITS_SHA256: 'PHONE_DIGITS_SHA256', // 14155551212 (Meta)
} as const;
export type HashProfile = (typeof HASH_PROFILES)[keyof typeof HASH_PROFILES];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

export interface NormalizedEmail {
  normalized: string; // lower/trim — the canonical stored value (encrypted)
  google: string; // google-specific normalization
  valid: boolean;
}

export function normalizeEmail(raw: string | null | undefined): NormalizedEmail | null {
  if (raw == null) return null;
  const normalized = raw.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return null;
  const valid = EMAIL_RE.test(normalized) && normalized.length <= 254;
  let google = normalized;
  const at = normalized.lastIndexOf('@');
  if (at > 0) {
    let local = normalized.slice(0, at);
    const domain = normalized.slice(at + 1);
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      local = local.replace(/\./g, '');
      const plus = local.indexOf('+');
      if (plus >= 0) local = local.slice(0, plus);
      google = `${local}@${domain}`;
    }
  }
  return { normalized, google, valid };
}

export interface NormalizedPhone {
  e164: string; // +14155551212
  digits: string; // 14155551212
  valid: boolean;
  country?: string;
}

export function normalizePhone(raw: string | null | undefined, defaultCountry?: string | null): NormalizedPhone | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cc = (defaultCountry?.toUpperCase() as CountryCode | undefined) ?? undefined;
  const parsed = parsePhoneNumberFromString(trimmed, cc);
  if (!parsed) {
    // keep a best-effort digits form so the identifier is still deterministic but flagged invalid
    const digits = trimmed.replace(/\D/g, '').replace(/^0+/, '');
    return digits ? { e164: '+' + digits, digits, valid: false } : null;
  }
  const valid = parsed.isValid();
  return { e164: parsed.number, digits: parsed.number.replace(/^\+/, ''), valid, country: parsed.country };
}

export interface IdentifierHashes {
  email?: { normalized: string; valid: boolean; hashes: Record<HashProfile, Buffer> };
  phone?: { e164: string; valid: boolean; hashes: Record<HashProfile, Buffer> };
}

/** Compute every hash profile for an email/phone pair. The canonical hash (customers.email_hash) is EMAIL_SHA256 / PHONE_E164_SHA256. */
export function hashIdentifiers(input: { email?: string | null; phone?: string | null; country?: string | null }): IdentifierHashes {
  const out: IdentifierHashes = {};
  const e = normalizeEmail(input.email);
  if (e) {
    out.email = {
      normalized: e.normalized,
      valid: e.valid,
      hashes: {
        EMAIL_SHA256: sha256(e.normalized),
        EMAIL_SHA256_GOOGLE: sha256(e.google),
      } as Record<HashProfile, Buffer>,
    };
  }
  const p = normalizePhone(input.phone, input.country);
  if (p) {
    out.phone = {
      e164: p.e164,
      valid: p.valid,
      hashes: {
        PHONE_E164_SHA256: sha256(p.e164),
        PHONE_DIGITS_SHA256: sha256(p.digits),
      } as Record<HashProfile, Buffer>,
    };
  }
  return out;
}

export const CANONICAL_EMAIL_PROFILE: HashProfile = 'EMAIL_SHA256';
export const CANONICAL_PHONE_PROFILE: HashProfile = 'PHONE_E164_SHA256';

export function emailHash(raw: string): Buffer | null {
  const e = normalizeEmail(raw);
  return e ? sha256(e.normalized) : null;
}
export function phoneHash(raw: string, country?: string | null): Buffer | null {
  const p = normalizePhone(raw, country);
  return p ? sha256(p.e164) : null;
}
