import { loadEnv, createDbWithPool, migrate, resetSchema } from '@aap/db';
loadEnv();
import { seedDemo } from './index.js';
import { resumeDemo } from './resume.js';

const args = process.argv.slice(2);
const get = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k: string) => args.includes(k);
const quick = has('--quick');
const customers = Number(get('--customers', quick ? '50000' : '1000000'));
const events = Number(get('--events', quick ? '500000' : '10000000'));
const seed = Number(get('--seed', '42'));

const { db, pool } = createDbWithPool({ max: 6, applicationName: 'aap-seed' });
const t0 = Date.now();
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`, Object.keys(extra).length ? JSON.stringify(extra) : '');
try {
  if (has('--reset')) { if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset production'); log('resetting schema'); await resetSchema(pool); await migrate(pool); }
  const r = has('--resume')
    ? await resumeDemo(db, pool, { orgSlug: get('--org-slug', 'demo')!, seed, activate: !has('--no-activate'), log })
    : await seedDemo(db, pool, { customers, events, seed, activate: !has('--no-activate'), orgSlug: get('--org-slug', 'demo'), log });
  console.log('\n=== Demo environment ready ===');
  console.log(`organization: ${r.organizationId}`);
  console.log(`customers: ${r.data.customers.toLocaleString()}  orders: ${r.data.orders.toLocaleString()}  events: ${r.data.events.toLocaleString()}  audiences: ${r.audiences}  synced destination audiences: ${r.activated}`);
  console.log('logins:'); for (const u of r.users) console.log(`  ${u.email.padEnd(22)} ${u.password.padEnd(16)} ${u.role}`);
} finally { await db.destroy(); }
