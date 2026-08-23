import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@aap/core', '@aap/db'],
  serverExternalPackages: ['pg', 'pg-copy-streams', 'pino', 'libphonenumber-js', 'bullmq', 'ioredis', 'kysely', '@electric-sql/pglite', 'dotenv'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  poweredByHeader: false,
  // workspace packages use ESM-style ".js" specifiers in TypeScript sources (NodeNext); map them for webpack
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'] };
    // optional redis client pulled in by bullmq (only used when REDIS_URL is set on the worker)
    config.resolve.alias = { ...(config.resolve.alias ?? {}), '@valkey/valkey-glide': false };
    return config;
  },
  headers: async () => [{ source: '/(.*)', headers: [
    { key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ] }],
};
export default nextConfig;
