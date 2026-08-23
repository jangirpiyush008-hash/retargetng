import { loadEnv, createDbWithPool, migrate, resetSchema } from '@aap/db';
loadEnv();
import { seedDemo } from './index.js';
import { resumeDemo } from './resume.js';
import { bootstrapOrganization } from '../platform/org.js';
import { hashPassword } from '../platform/auth.js';

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
  if (has('--bootstrap')) {
    // First admin / organization from env — idempotent, safe to run on every boot.
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase(); const password = process.env.BOOTSTRAP_ADMIN_PASSWORD; const orgName = process.env.BOOTSTRAP_ORG_NAME ?? 'My Organization';
    if (!email || !password) { console.log('bootstrap: BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set — nothing to do'); process.exit(0); }
    if (password.length < 10) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters');
    const existingUser = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    const firstOrg = await db.selectFrom('organizations').select(['id', 'name']).orderBy('created_at').executeTakeFirst();
    if (existingUser && firstOrg) { await db.insertInto('organization_members').values({ organization_id: firstOrg.id, user_id: existingUser.id, role: 'ADMIN' }).onConflict((oc) => oc.doNothing()).execute(); console.log(`bootstrap: ${email} already exists (member of "${firstOrg.name}")`); process.exit(0); }
    if (!firstOrg) { const r = await bootstrapOrganization(db, { name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org', admin: { email, name: 'Administrator', password } }); console.log(`bootstrap: created organization "${orgName}" (${r.organizationId}) and admin ${email}`); process.exit(0); }
    const u = await db.insertInto('users').values({ email, name: 'Administrator', password_hash: await hashPassword(password) }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('organization_members').values({ organization_id: firstOrg.id, user_id: u.id, role: 'ADMIN' }).execute();
    console.log(`bootstrap: created admin ${email} in existing organization "${firstOrg.name}"`); process.exit(0);
  }
  if (has('--if-empty')) {
    const org = await db.selectFrom('organizations').select('id').where('slug', '=', get('--org-slug', 'demo')!).executeTakeFirst();
    if (org) { console.log('demo seed: organization already exists — skipping'); process.exit(0); }
  }
  if (has('--reset')) { if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset production'); log('resetting schema'); await resetSchema(pool); await migrate(pool); }
  const r = has('--resume')
    ? await resumeDemo(db, pool, { orgSlug: get('--org-slug', 'demo')!, seed, activate: !has('--no-activate'), log })
    : await seedDemo(db, pool, { customers, events, seed, activate: !has('--no-activate'), orgSlug: get('--org-slug', 'demo'), log });
  console.log('\n=== Demo environment ready ===');
  console.log(`organization: ${r.organizationId}`);
  console.log(`customers: ${r.data.customers.toLocaleString()}  orders: ${r.data.orders.toLocaleString()}  events: ${r.data.events.toLocaleString()}  audiences: ${r.audiences}  synced destination audiences: ${r.activated}`);
  console.log('logins:'); for (const u of r.users) console.log(`  ${u.email.padEnd(22)} ${u.password.padEnd(16)} ${u.role}`);
} finally { await db.destroy(); }
