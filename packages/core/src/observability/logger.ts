import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logger with mandatory PII redaction. Raw identifiers never reach logs:
 * any key that looks like an identifier or payload is censored. Hashes are allowed but
 * truncated by callers (use maskHash()).
 */
const REDACT_PATHS = [
  'email', '*.email', '*.*.email', 'phone', '*.phone', '*.*.phone',
  'emails', '*.emails', 'phones', '*.phones',
  'payload', '*.payload', 'data', '*.data', 'req.headers.authorization', 'headers.authorization',
  'access_token', '*.access_token', 'refresh_token', '*.refresh_token', 'token', '*.token',
  'password', '*.password', 'secret', '*.secret', 'invalid_entry_samples', '*.invalid_entry_samples',
];

export function createLogger(opts: { name?: string; level?: string } = {}): Logger {
  const options: LoggerOptions = {
    name: opts.name ?? 'aap',
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: opts.name ?? 'aap', env: process.env.NODE_ENV ?? 'development' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(options);
}

let root: Logger | undefined;
export function logger(): Logger {
  if (!root) root = createLogger();
  return root;
}

/** Display-safe form of a hash (first 8 hex chars). */
export function maskHash(hash: Buffer | string | null | undefined): string | null {
  if (!hash) return null;
  const hex = Buffer.isBuffer(hash) ? hash.toString('hex') : hash;
  return hex.slice(0, 8) + '…';
}

/** Strip anything that could contain PII from an unknown error before persisting it. */
export function sanitizeError(err: unknown, maxLen = 500): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // crude but effective: drop email-like and long digit sequences
  return msg
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .slice(0, maxLen);
}
