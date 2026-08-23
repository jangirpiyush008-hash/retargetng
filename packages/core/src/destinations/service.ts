import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { DestinationRegistry, DESTINATION_CATALOG } from './registry.js';
import type { DestinationContext } from './types.js';
import type { SecretStore } from '../secrets/index.js';
import { secretRef } from '../secrets/index.js';
import { AuditLogger } from '../audit/index.js';
import { assertCan, type Principal } from '../rbac/index.js';
import { NotFoundError, ValidationError } from '../util/index.js';
import { logger, sanitizeError } from '../observability/logger.js';

/** Connect / test / manage destinations. Credentials go to the SecretStore; the DB stores references only. */
export class DestinationService {
  private audit: AuditLogger;
  private log = logger().child({ module: 'destinations' });
  constructor(private db: Kysely<DB>, private secrets: SecretStore, private registry = new DestinationRegistry()) { this.audit = new AuditLogger(db); }

  catalog() { return DESTINATION_CATALOG.map((c) => ({ ...c, mode: this.registry.isMock(c.type) ? 'mock' : 'live' })); }

  private ctx(d: { id: string; organization_id: string; type: string; config: unknown; credential_ref: string | null }): DestinationContext {
    return { destinationId: d.id, organizationId: d.organization_id, type: d.type, config: (d.config as Record<string, unknown>) ?? {}, credentialRef: d.credential_ref, secrets: this.secrets, fetch, log: this.log.child({ destination: d.type }) };
  }

  async list(org: string) {
    const rows = await this.db.selectFrom('destinations as d').leftJoin('destination_accounts as da', 'da.destination_id', 'd.id').leftJoin('audience_destinations as ad', (j) => j.onRef('ad.destination_account_id', '=', 'da.id').on('ad.status', '<>', 'DELETED'))
      .select(['d.id', 'd.type', 'd.name', 'd.status', 'd.config', 'd.connection_status', 'd.last_tested_at', 'd.last_sync_at', 'd.last_error', 'd.created_at'])
      .select((eb) => [eb.fn.count<number>('da.id').distinct().as('account_count'), eb.fn.count<number>('ad.id').distinct().as('audience_count'), eb.fn.count<number>('ad.id').distinct().filterWhere('ad.status', '=', 'ERROR').as('failed_audiences')])
      .where('d.organization_id', '=', org).groupBy('d.id').orderBy('d.created_at').execute();
    return rows.map((r) => ({ ...r, mode: this.registry.isMock(r.type) ? 'mock' : 'live', credential_ref: undefined }));
  }
  async get(org: string, id: string) {
    const d = await this.db.selectFrom('destinations').selectAll().where('organization_id', '=', org).where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundError('Destination not found');
    const accounts = await this.db.selectFrom('destination_accounts').selectAll().where('destination_id', '=', id).orderBy('name').execute();
    const audiences = await this.db.selectFrom('audience_destinations as ad').innerJoin('audiences as a', 'a.id', 'ad.audience_id').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id')
      .select(['ad.id', 'ad.status', 'ad.external_audience_id', 'ad.last_synced_at', 'ad.next_sync_at', 'ad.submitted_count', 'ad.matched_count', 'ad.match_rate', 'ad.last_error', 'a.id as audience_id', 'a.name as audience_name', 'da.name as account_name'])
      .where('da.destination_id', '=', id).where('ad.status', '<>', 'DELETED').orderBy('a.name').execute();
    return { ...d, credential_ref: undefined, hasCredential: !!d.credential_ref, mode: this.registry.isMock(d.type) ? 'mock' : 'live', accounts, audiences };
  }

  /** Create + connect. `credential` is the raw secret (token or JSON) — stored in the SecretStore only. */
  async connect(principal: Principal, input: { type: string; name: string; config?: Record<string, unknown>; credential?: string; credentials?: Record<string, string> }) {
    assertCan(principal, 'destinations:manage');
    const org = principal.organizationId;
    if (!DESTINATION_CATALOG.some((c) => c.type === input.type)) throw new ValidationError(`Unsupported destination type ${input.type}`);
    const isMock = this.registry.isMock(input.type);
    const d = await this.db.insertInto('destinations').values({ organization_id: org, type: input.type, name: input.name, status: 'PENDING', config: JSON.stringify(input.config ?? {}), created_by: principal.id }).returning(['id']).executeTakeFirstOrThrow();
    const config: Record<string, unknown> = { ...(input.config ?? {}) };
    let credentialRef: string | null = null;
    if (input.credential) { credentialRef = secretRef([input.type.toLowerCase(), d.id, 'credential']); await this.secrets.put(credentialRef, input.credential); }
    for (const [k, v] of Object.entries(input.credentials ?? {})) { const ref = secretRef([input.type.toLowerCase(), d.id, k]); await this.secrets.put(ref, v); config[`${k}_ref`] = ref; }
    if (!credentialRef && !isMock) throw new ValidationError('A credential is required for live destinations');
    await this.db.updateTable('destinations').set({ credential_ref: credentialRef, config: JSON.stringify(config) }).where('id', '=', d.id).execute();
    const res = await this.test(principal, d.id);
    await this.audit.log({ organizationId: org, actor: principal, action: 'DESTINATION_CONNECTED', entityType: 'destination', entityId: d.id, after: { type: input.type, name: input.name, ok: res.ok, mode: isMock ? 'mock' : 'live' } });
    return { id: d.id, ...res };
  }

  /** adapter.connect(): validates credentials and refreshes the selectable account list. */
  async test(principal: Principal, id: string) {
    assertCan(principal, 'destinations:manage');
    const d = await this.db.selectFrom('destinations').selectAll().where('organization_id', '=', principal.organizationId).where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundError('Destination not found');
    const adapter = this.registry.get(d.type);
    let ok = false, message = '', accounts: Array<{ externalAccountId: string; name: string; currency?: string; timezone?: string; metadata?: Record<string, unknown> }> = [];
    try { const r = await adapter.connect(this.ctx(d)); ok = r.ok; message = r.message ?? ''; accounts = r.accounts; }
    catch (e) { ok = false; message = sanitizeError(e); }
    await this.db.updateTable('destinations').set({ status: ok ? 'CONNECTED' : 'ERROR', connection_status: JSON.stringify({ ok, message, checked_at: new Date().toISOString(), accounts_visible: accounts.length }), last_tested_at: new Date(), last_error: ok ? null : message, updated_at: new Date() }).where('id', '=', id).execute();
    if (ok) {
      for (const a of accounts) {
        await this.db.insertInto('destination_accounts').values({ destination_id: id, organization_id: principal.organizationId, external_account_id: a.externalAccountId, name: a.name, currency: a.currency?.slice(0, 3) ?? null, timezone: a.timezone ?? null, metadata: JSON.stringify(a.metadata ?? {}), status: 'ACTIVE' })
          .onConflict((oc) => oc.columns(['destination_id', 'external_account_id']).doUpdateSet({ name: a.name, currency: a.currency?.slice(0, 3) ?? null, timezone: a.timezone ?? null, updated_at: new Date() })).execute();
      }
    }
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'DESTINATION_TESTED', entityType: 'destination', entityId: id, metadata: { ok, accounts: accounts.length } });
    return { ok, message, accounts };
  }

  async validateAccount(principal: Principal, id: string, accountId: string) {
    assertCan(principal, 'destinations:manage');
    const d = await this.db.selectFrom('destinations').selectAll().where('organization_id', '=', principal.organizationId).where('id', '=', id).executeTakeFirstOrThrow();
    const a = await this.db.selectFrom('destination_accounts').selectAll().where('id', '=', accountId).where('destination_id', '=', id).executeTakeFirstOrThrow();
    const r = await this.registry.get(d.type).validate(this.ctx(d), a.external_account_id);
    await this.db.updateTable('destination_accounts').set({ metadata: JSON.stringify({ ...(a.metadata as object), validation: { ...r, checked_at: new Date().toISOString() } }), updated_at: new Date() }).where('id', '=', accountId).execute();
    return r;
  }

  async setDefaultAccount(principal: Principal, id: string, accountId: string) {
    assertCan(principal, 'destinations:manage');
    await this.db.updateTable('destination_accounts').set({ is_default: false }).where('destination_id', '=', id).execute();
    await this.db.updateTable('destination_accounts').set({ is_default: true }).where('id', '=', accountId).where('destination_id', '=', id).execute();
  }

  async disconnect(principal: Principal, id: string) {
    assertCan(principal, 'destinations:manage');
    const d = await this.db.selectFrom('destinations').selectAll().where('organization_id', '=', principal.organizationId).where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundError('Destination not found');
    if (d.credential_ref) await this.secrets.delete(d.credential_ref).catch(() => {});
    await this.db.updateTable('destinations').set({ status: 'DISCONNECTED', credential_ref: null, updated_at: new Date() }).where('id', '=', id).execute();
    await this.db.updateTable('audience_destinations as ad').set({ status: 'PAUSED' }).where('ad.destination_account_id', 'in', (eb) => eb.selectFrom('destination_accounts').select('id').where('destination_id', '=', id)).where('ad.status', 'in', ['ACTIVE', 'PENDING_CREATE', 'ERROR']).execute();
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'DESTINATION_DISCONNECTED', entityType: 'destination', entityId: id });
  }

  async reconnect(principal: Principal, id: string, credential: string) {
    assertCan(principal, 'destinations:manage');
    const d = await this.db.selectFrom('destinations').selectAll().where('organization_id', '=', principal.organizationId).where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundError('Destination not found');
    const ref = d.credential_ref ?? secretRef([d.type.toLowerCase(), d.id, 'credential']);
    await this.secrets.put(ref, credential);
    await this.db.updateTable('destinations').set({ credential_ref: ref, status: 'PENDING', last_error: null, updated_at: new Date() }).where('id', '=', id).execute();
    const r = await this.test(principal, id);
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'DESTINATION_RECONNECTED', entityType: 'destination', entityId: id, metadata: { ok: r.ok } });
    return r;
  }

  async remove(principal: Principal, id: string) {
    assertCan(principal, 'destinations:manage');
    const d = await this.db.selectFrom('destinations').selectAll().where('organization_id', '=', principal.organizationId).where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundError('Destination not found');
    const active = await this.db.selectFrom('audience_destinations as ad').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').select('ad.id').where('da.destination_id', '=', id).where('ad.status', 'not in', ['DELETED']).executeTakeFirst();
    if (active) throw new ValidationError('Deactivate all audiences on this destination before removing it');
    if (d.credential_ref) await this.secrets.delete(d.credential_ref).catch(() => {});
    await this.db.deleteFrom('destinations').where('id', '=', id).execute();
    await this.audit.log({ organizationId: principal.organizationId, actor: principal, action: 'DESTINATION_REMOVED', entityType: 'destination', entityId: id, before: { type: d.type, name: d.name } });
  }
}
