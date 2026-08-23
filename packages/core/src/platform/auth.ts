import { scrypt as _scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { sha256, randomToken } from '../crypto/hash.js';
import { permissionsForRole, type Permission, type Principal, type Role } from '../rbac/index.js';
import { NotFoundError, ValidationError } from '../util/index.js';

const scrypt = promisify(_scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = (await scrypt(password, Buffer.from(saltB64, 'base64'), 64)) as Buffer;
  const expected = Buffer.from(keyB64, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface SessionInfo { principal: Principal; userId: string; userName: string; sessionId: string; expiresAt: Date; organizations: Array<{ id: string; name: string; slug: string; role: Role }>; permissions: Permission[] }

/**
 * Local auth provider: users + scrypt passwords + DB-backed sessions (cookie holds a random token;
 * DB stores its sha256). Replace with Supabase Auth / SSO by implementing the same two methods
 * used by the web app: login() and resolveSession().
 */
export class AuthService {
  constructor(private db: Kysely<DB>, private opts: { sessionTtlDays?: number } = {}) {}

  async login(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ token: string; session: SessionInfo }> {
    const user = await this.db.selectFrom('users').selectAll().where('email', '=', email.trim().toLowerCase()).where('disabled_at', 'is', null).executeTakeFirst();
    if (!user) {
      const any = await this.db.selectFrom('users').select('id').limit(1).executeTakeFirst();
      if (!any) throw new ValidationError('No users exist yet. Create the first admin with BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD, or run the demo seed (DEMO_SEED=quick or `pnpm db:seed -- --quick`).');
    }
    if (!user || !(await verifyPassword(password, user.password_hash))) throw new ValidationError('Invalid email or password');
    const memberships = await this.db.selectFrom('organization_members as m').innerJoin('organizations as o', 'o.id', 'm.organization_id').select(['o.id', 'o.name', 'o.slug', 'm.role']).where('m.user_id', '=', user.id).orderBy('o.name').execute();
    if (!memberships.length && !user.is_super_admin) throw new ValidationError('User has no organization');
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + (this.opts.sessionTtlDays ?? 14) * 86400_000);
    const s = await this.db.insertInto('sessions').values({ user_id: user.id, organization_id: memberships[0]?.id ?? null, token_hash: sha256(token), expires_at: expiresAt, ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 300) ?? null }).returning('id').executeTakeFirstOrThrow();
    await this.db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
    const session = (await this.resolveSession(token))!;
    void s;
    return { token, session };
  }

  async logout(token: string) { await this.db.deleteFrom('sessions').where('token_hash', '=', sha256(token)).execute(); }

  async resolveSession(token: string | null | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const s = await this.db.selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id').select(['s.id', 's.expires_at', 's.organization_id', 'u.id as user_id', 'u.email', 'u.name', 'u.is_super_admin', 'u.disabled_at']).where('s.token_hash', '=', sha256(token)).executeTakeFirst();
    if (!s || s.expires_at < new Date() || s.disabled_at) return null;
    const memberships = await this.db.selectFrom('organization_members as m').innerJoin('organizations as o', 'o.id', 'm.organization_id').select(['o.id', 'o.name', 'o.slug', 'm.role']).where('m.user_id', '=', s.user_id).orderBy('o.name').execute();
    const current = memberships.find((m) => m.id === s.organization_id) ?? memberships[0];
    if (!current) return null;
    const role = (s.is_super_admin ? 'SUPER_ADMIN' : current.role) as Role;
    // touch last_seen at most once a minute
    this.db.updateTable('sessions').set({ last_seen_at: new Date() }).where('id', '=', s.id).execute().catch(() => {});
    return {
      sessionId: s.id, userId: s.user_id, userName: s.name, expiresAt: s.expires_at,
      principal: { type: 'USER', id: s.user_id, label: s.email, organizationId: current.id, role },
      organizations: memberships.map((m) => ({ id: m.id, name: m.name, slug: m.slug, role: m.role as Role })),
      permissions: permissionsForRole(role),
    };
  }

  async switchOrganization(token: string, organizationId: string) {
    const s = await this.resolveSession(token);
    if (!s) throw new NotFoundError('Session not found');
    if (!s.organizations.some((o) => o.id === organizationId) && s.principal.role !== 'SUPER_ADMIN') throw new ValidationError('Not a member of that organization');
    await this.db.updateTable('sessions').set({ organization_id: organizationId }).where('id', '=', s.sessionId).execute();
  }

  // ---------------------------------------------------------------- API keys
  /** Creates an API key; the full key is returned ONCE. Format: aap_<env>_<prefix>_<secret>. */
  async createApiKey(principal: Principal, input: { name: string; scopes: Permission[]; expiresAt?: Date | null }): Promise<{ id: string; key: string; prefix: string }> {
    const env = process.env.NODE_ENV === 'production' ? 'live' : 'test';
    const prefix = randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
    const secret = randomToken(24);
    const key = `aap_${env}_${prefix}_${secret}`;
    const r = await this.db.insertInto('api_keys').values({ organization_id: principal.organizationId, name: input.name, key_prefix: `aap_${env}_${prefix}`, key_hash: sha256(key), scopes: input.scopes, created_by: principal.id, expires_at: input.expiresAt ?? null }).returning('id').executeTakeFirstOrThrow();
    return { id: r.id, key, prefix: `aap_${env}_${prefix}` };
  }
  async revokeApiKey(principal: Principal, id: string) {
    await this.db.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', id).where('organization_id', '=', principal.organizationId).execute();
  }
  async resolveApiKey(key: string | null | undefined): Promise<Principal | null> {
    if (!key || !key.startsWith('aap_')) return null;
    const r = await this.db.selectFrom('api_keys').selectAll().where('key_hash', '=', sha256(key)).where('revoked_at', 'is', null).executeTakeFirst();
    if (!r || (r.expires_at && r.expires_at < new Date())) return null;
    this.db.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', r.id).execute().catch(() => {});
    return { type: 'API_KEY', id: r.id, label: r.name, organizationId: r.organization_id, role: 'VIEW_ONLY', scopes: r.scopes as Permission[] };
  }
}
