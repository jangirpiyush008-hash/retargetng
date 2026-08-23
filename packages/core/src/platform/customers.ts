import type { Kysely } from 'kysely';
import type { DB } from '@aap/db';
import { emailHash, phoneHash } from '../identity/normalize.js';
import { maskHash } from '../observability/logger.js';
import { can, type Principal } from '../rbac/index.js';
import { NotFoundError } from '../util/index.js';
import { evaluatePolicy, parsePolicy } from '../consent/policy.js';
import { piiCipher } from '../crypto/pii.js';

/** Masked customer views for the dashboard. Raw PII is only decrypted for principals with customers:read_pii. */
export class CustomerService {
  constructor(private db: Kysely<DB>) {}

  /** `q` may be an external id, an email or a phone — email/phone are hashed server-side, never searched in clear. */
  async search(principal: Principal, q: string | undefined, opts: { cursor?: string; limit?: number; lifecycle?: string; consent?: string; suppressed?: boolean } = {}) {
    const org = principal.organizationId;
    const limit = Math.min(100, opts.limit ?? 25);
    let query = this.db.selectFrom('customers').select(['id', 'external_customer_id', 'email_hash', 'phone_hash', 'country', 'region', 'lifecycle_state', 'status', 'order_count', 'total_revenue', 'lifetime_value', 'last_order_at', 'last_activity_at', 'has_open_cart', 'consent_status', 'advertising_personalization_allowed', 'data_sharing_allowed', 'marketing_allowed', 'suppressed', 'deleted', 'created_at', 'updated_at'])
      .where('organization_id', '=', org).orderBy('id', 'desc').limit(limit + 1);
    if (opts.cursor) query = query.where('id', '<', Number(opts.cursor));
    if (q && q.trim()) {
      const s = q.trim();
      const eh = s.includes('@') ? emailHash(s) : null;
      const ph = /^\+?[\d\s().-]{6,}$/.test(s) ? phoneHash(s, 'IN') : null;
      query = query.where((eb) => eb.or([eb('external_customer_id', '=', s), ...(eh ? [eb('email_hash', '=', eh)] : []), ...(ph ? [eb('phone_hash', '=', ph)] : []), ...(/^\d+$/.test(s) ? [eb('id', '=', Number(s))] : [])]));
    }
    if (opts.lifecycle) query = query.where('lifecycle_state', '=', opts.lifecycle);
    if (opts.consent) query = query.where('consent_status', '=', opts.consent);
    if (opts.suppressed !== undefined) query = query.where('suppressed', '=', opts.suppressed);
    const rows = await query.execute();
    const page = rows.slice(0, limit).map((r) => ({ ...r, email_hash: maskHash(r.email_hash), phone_hash: maskHash(r.phone_hash) }));
    return { data: page, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null };
  }

  async detail(principal: Principal, id: number) {
    const org = principal.organizationId;
    const c = await this.db.selectFrom('customers').selectAll().where('organization_id', '=', org).where('id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundError('Customer not found');
    const [memberships, consent, suppression, orders, identity, destinations, policyRow] = await Promise.all([
      this.db.selectFrom('audience_members as m').innerJoin('audiences as a', 'a.id', 'm.audience_id').select(['a.id', 'a.name', 'a.slug', 'a.priority', 'm.status', 'm.is_primary', 'm.entered_at', 'm.exited_at']).where('m.customer_id', '=', id).orderBy('m.status').orderBy('a.priority').limit(100).execute(),
      this.db.selectFrom('consent_events').select(['event_type', 'purposes', 'source', 'legal_basis', 'occurred_at']).where('customer_id', '=', id).orderBy('occurred_at', 'desc').limit(20).execute(),
      this.db.selectFrom('suppression_records').select(['id', 'reason', 'source', 'created_at', 'revoked_at', 'expires_at']).where('customer_id', '=', id).orderBy('created_at', 'desc').execute(),
      this.db.selectFrom('orders').select(['id', 'external_order_id', 'status', 'total', 'currency', 'item_count', 'ordered_at']).where('customer_id', '=', id).orderBy('ordered_at', 'desc').limit(20).execute(),
      this.db.selectFrom('identity_history').select(['kind', 'previous_hash', 'new_hash', 'reason', 'occurred_at']).where('customer_id', '=', id).orderBy('occurred_at', 'desc').limit(20).execute(),
      this.db.selectFrom('audience_destination_members as adm').innerJoin('audience_destinations as ad', 'ad.id', 'adm.audience_destination_id').innerJoin('audiences as a', 'a.id', 'ad.audience_id').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id')
        .select(['a.name as audience_name', 'd.type as destination_type', 'da.name as account_name', 'adm.state', 'adm.added_at', 'adm.removed_at', 'adm.last_error_code']).where('adm.customer_id', '=', id).limit(100).execute(),
      this.db.selectFrom('compliance_policies').select('rules').where('organization_id', '=', org).where('destination_type', 'is', null).orderBy('is_default', 'desc').executeTakeFirst(),
    ]);
    const policy = parsePolicy(policyRow?.rules ?? {});
    const eligibilityReasons = evaluatePolicy(policy, { ...c, consent_status: c.consent_status as never }, new Date());
    const showPii = can(principal, 'customers:read_pii');
    let email: string | null = null, phone: string | null = null;
    if (showPii) { try { const ci = piiCipher(); email = c.email_encrypted ? ci.decrypt(c.email_encrypted) : null; phone = c.phone_encrypted ? ci.decrypt(c.phone_encrypted) : null; } catch { /* key mismatch → stay masked */ } }
    return {
      customer: { ...c, email_encrypted: undefined, phone_encrypted: undefined, email_hash: maskHash(c.email_hash), phone_hash: maskHash(c.phone_hash), email, phone, pii_visible: showPii },
      eligibility: { eligible: eligibilityReasons.length === 0, reasons: eligibilityReasons },
      memberships, consent, suppression, orders, identity: identity.map((i) => ({ ...i, previous_hash: maskHash(i.previous_hash), new_hash: maskHash(i.new_hash) })), destinations,
    };
  }

  /** Lifecycle / consent / country breakdowns from the hourly organization_stats snapshot (never scans per page view). */
  async stats(org: string) {
    const { MeasurementService } = await import('../measurement/index.js');
    const b = await new MeasurementService(this.db).customerBreakdown(org);
    return { lifecycle: b.lifecycle, consent: b.consent, countries: b.countries, computedAt: b.computedAt };
  }
}
