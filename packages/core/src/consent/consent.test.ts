import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, type TestDb } from '@aap/db/test-utils';
import { applyConsentEvent, INITIAL_CONSENT } from './state.js';
import { parsePolicy, evaluatePolicy, compilePolicyPredicate, compilePolicyReasonExpr, DEFAULT_POLICY, type CustomerConsentView } from './policy.js';
import { createOrg, insertCustomer } from '../testing/fixtures.js';

describe('consent reducer', () => {
  const t0 = new Date('2026-01-01T00:00:00Z'), t1 = new Date('2026-02-01T00:00:00Z'), t2 = new Date('2026-03-01T00:00:00Z');
  it('grant → revoke → status DENIED and flags off', () => {
    let s = applyConsentEvent(INITIAL_CONSENT, { type: 'CONSENT_GRANTED', purposes: { marketing: true, advertising_personalization: true, data_sharing: true }, occurredAt: t0 });
    expect(s.consent_status).toBe('GRANTED');
    s = applyConsentEvent(s, { type: 'CONSENT_REVOKED', occurredAt: t1 });
    expect(s).toMatchObject({ consent_status: 'DENIED', marketing_allowed: false, advertising_personalization_allowed: false, data_sharing_allowed: false });
  });
  it('partial revoke keeps other purposes', () => {
    let s = applyConsentEvent(INITIAL_CONSENT, { type: 'CONSENT_GRANTED', occurredAt: t0 });
    s = applyConsentEvent(s, { type: 'CONSENT_REVOKED', purposes: { marketing: false }, occurredAt: t1 });
    expect(s).toMatchObject({ consent_status: 'GRANTED', marketing_allowed: false, advertising_personalization_allowed: true });
  });
  it('ignores out-of-order older events', () => {
    let s = applyConsentEvent(INITIAL_CONSENT, { type: 'CONSENT_REVOKED', occurredAt: t2 });
    s = applyConsentEvent(s, { type: 'CONSENT_GRANTED', occurredAt: t1 });
    expect(s.consent_status).toBe('DENIED');
  });
  it('explicit update with advertising=false is DENIED', () => {
    const s = applyConsentEvent(INITIAL_CONSENT, { type: 'CONSENT_UPDATED', purposes: { marketing: true, advertising_personalization: false }, occurredAt: t0 });
    expect(s.consent_status).toBe('DENIED');
    expect(s.marketing_allowed).toBe(true);
  });
});

describe('compliance policy: TS evaluator ≡ SQL predicate', () => {
  let t: TestDb; let org: string;
  const NOW = new Date('2026-08-23T12:00:00Z');
  beforeAll(async () => { t = await createTestDb(); await t.truncateAll(); org = await createOrg(t.db); });
  afterAll(async () => { await t.close(); });

  it('agrees on a grid of customers for several policies', async () => {
    const grid: Parameters<typeof insertCustomer>[2][] = [];
    for (const consent of ['GRANTED', 'DENIED', 'UNKNOWN', 'EXPIRED'] as const)
      for (const adv of [true, false]) for (const share of [true, false]) for (const country of ['IN', 'DE', 'US', null])
        for (const idc of [{ email: 'x@e.com', phone: null }, { email: null, phone: '+919876543210' }, { email: null, phone: null }, { email: 'bad', phone: null, email_valid: false }])
          for (const supp of [false, true])
            grid.push({ consent_status: consent, advertising_personalization_allowed: adv, data_sharing_allowed: share, country, suppressed: supp,
              consent_updated_at: consent === 'GRANTED' ? new Date(NOW.getTime() - 400 * 86400_000) : NOW, ...idc });
    for (const g of grid) await insertCustomer(t.db, org, g);

    const policies = [
      DEFAULT_POLICY,
      parsePolicy({ allowConsentStatus: ['GRANTED', 'UNKNOWN'], requireFlags: ['advertising_personalization_allowed'], blockedCountries: ['DE'], requireIdentifier: 'EMAIL' }),
      parsePolicy({ consentMaxAgeDays: 365, regionOverrides: [{ countries: ['US'], allowConsentStatus: ['GRANTED', 'UNKNOWN'], requireFlags: [] }, { countries: ['DE'], blocked: true }], requireIdentifier: 'ANY', requireValidIdentifier: false }),
      parsePolicy({ requireIdentifier: 'BOTH' }),
    ];
    const rows = await t.db.selectFrom('customers').selectAll().where('organization_id', '=', org).execute();
    for (const policy of policies) {
      const sqlEligible = new Set((await sql<{ id: number }>`SELECT c.id FROM customers c WHERE c.organization_id = ${org} AND ${compilePolicyPredicate(policy, NOW)}`.execute(t.db)).rows.map((r) => r.id));
      const reasons = new Map((await sql<{ id: number; reason: string | null }>`SELECT c.id, ${compilePolicyReasonExpr(policy, NOW)} AS reason FROM customers c WHERE c.organization_id = ${org}`.execute(t.db)).rows.map((r) => [r.id, r.reason]));
      for (const r of rows) {
        const view: CustomerConsentView = { ...r, consent_status: r.consent_status as never, email_hash: r.email_hash, phone_hash: r.phone_hash };
        const tsReasons = evaluatePolicy(policy, view, NOW);
        const tsEligible = tsReasons.length === 0;
        expect(sqlEligible.has(r.id), `policy mismatch for customer ${JSON.stringify({ ...r, email_hash: undefined, phone_hash: undefined })} ts=${tsReasons}`).toBe(tsEligible);
        // reason expression: null iff eligible, and first TS reason matches
        if (tsEligible) expect(reasons.get(r.id)).toBeNull();
        else expect(reasons.get(r.id)).toBe(tsReasons[0]);
      }
    }
  });
});
