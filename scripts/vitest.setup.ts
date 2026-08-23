import 'dotenv/config';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = 'silent';
process.env.PII_ENCRYPTION_KEYS =
  process.env.PII_ENCRYPTION_KEYS ??
  'test:000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret';
process.env.DESTINATION_MODE = 'mock';
