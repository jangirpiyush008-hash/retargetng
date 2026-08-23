import { createHash } from 'node:crypto';
import type { AdapterAccount, AudienceRef, AudienceSpec, AudienceStatus, BatchMeta, BatchResult, DestinationAdapter, DestinationCapabilities, DestinationContext, DestinationType, MemberRecord } from '../types.js';
import { DestinationError } from '../types.js';

export interface MockFailurePlan {
  /** throw RATE_LIMITED on every Nth add/remove call (1-based counter) */
  rateLimitEvery?: number;
  /** throw TRANSIENT on these batchSeq values (once each) */
  transientOnSeq?: number[];
  /** throw INVALID_REQUEST on these batchSeq values */
  invalidOnSeq?: number[];
  /** throw AUTH_EXPIRED on all calls */
  authExpired?: boolean;
  /** mark this fraction of identifiers as invalid (0..1) */
  invalidFraction?: number;
}

interface MockAudience { id: string; name: string; account: string; members: Set<string>; people: Map<string, string[]>; deleted: boolean; recovered: boolean; createdAt: Date; updatedAt: Date }
const personKey = (m: MemberRecord) => m.identifiers.map((i) => i.hashHex).sort().join('|');

/**
 * In-memory destination used for development and tests. Behaves like the real platforms:
 * hashed identifiers in, approximate counts / match rates out, rate limits and failures on demand.
 * A deterministic 70% of hashes "match" (hash byte < 0xB3) so match-rate reporting is realistic.
 */
export class MockDestinationAdapter implements DestinationAdapter {
  static stores = new Map<string, Map<string, MockAudience>>(); // per (type) → audiences by id
  readonly capabilities: DestinationCapabilities;
  failures: MockFailurePlan = {};
  calls: Array<{ op: string; audience: string; count: number; seq?: number; dryRun?: boolean }> = [];
  private counter = 0;
  private firedTransient = new Set<number>();

  constructor(public readonly type: DestinationType, flavor: 'META' | 'GOOGLE') {
    this.capabilities = flavor === 'META'
      ? { hashProfiles: { EMAIL: 'EMAIL_SHA256', PHONE: 'PHONE_DIGITS_SHA256' }, maxBatchSize: 10_000, supportsRemove: true, supportsReplace: true, matchReporting: 'range', minAudienceSize: 100 }
      : { hashProfiles: { EMAIL: 'EMAIL_SHA256_GOOGLE', PHONE: 'PHONE_E164_SHA256' }, maxBatchSize: 10_000, supportsRemove: true, supportsReplace: false, matchReporting: 'rate', minAudienceSize: 100 };
  }
  private store(): Map<string, MockAudience> {
    let s = MockDestinationAdapter.stores.get(this.type);
    if (!s) { s = new Map(); MockDestinationAdapter.stores.set(this.type, s); }
    return s;
  }
  static reset() { MockDestinationAdapter.stores.clear(); }

  private maybeFail(seq?: number) {
    if (this.failures.authExpired) throw new DestinationError('mock: access token expired', 'AUTH_EXPIRED', false, { code: '190' });
    this.counter++;
    if (this.failures.rateLimitEvery && this.counter % this.failures.rateLimitEvery === 0) throw new DestinationError('mock: rate limited', 'RATE_LIMITED', true, { retryAfterMs: 10, code: '17' });
    if (seq != null && this.failures.transientOnSeq?.includes(seq) && !this.firedTransient.has(seq)) { this.firedTransient.add(seq); throw new DestinationError('mock: 500', 'TRANSIENT', true, { status: 500 }); }
    if (seq != null && this.failures.invalidOnSeq?.includes(seq)) throw new DestinationError('mock: invalid parameter', 'INVALID_REQUEST', false, { code: '100' });
  }

  async connect(ctx: DestinationContext) {
    const token = ctx.credentialRef ? await ctx.secrets.get(ctx.credentialRef) : 'mock';
    if (!token) return { ok: false, message: 'No credential found for reference', accounts: [] as AdapterAccount[] };
    const accounts: AdapterAccount[] = this.type.includes('GOOGLE')
      ? [{ externalAccountId: '1234567890', name: 'Mock Google Ads — Main', currency: 'INR', timezone: 'Asia/Kolkata' }, { externalAccountId: '2234567890', name: 'Mock Google Ads — Brand B', currency: 'INR', timezone: 'Asia/Kolkata' }]
      : [{ externalAccountId: 'act_100000001', name: 'Mock Meta Ad Account — Main', currency: 'INR', timezone: 'Asia/Kolkata' }, { externalAccountId: 'act_100000002', name: 'Mock Meta Ad Account — Brand B', currency: 'INR', timezone: 'Asia/Kolkata' }];
    return { ok: true, message: 'Mock connection OK (no data leaves this system)', accounts };
  }
  async validate(_ctx: DestinationContext, externalAccountId: string) { return { ok: true, message: `Mock account ${externalAccountId} ready`, details: { tos_accepted: true } }; }
  async createAudience(_ctx: DestinationContext, spec: AudienceSpec) {
    const id = `mock_${this.type.toLowerCase()}_${createHash('sha1').update(spec.externalAccountId + spec.name + Date.now()).digest('hex').slice(0, 12)}`;
    this.store().set(id, { id, name: spec.name, account: spec.externalAccountId, members: new Set(), people: new Map(), deleted: false, recovered: false, createdAt: new Date(), updatedAt: new Date() });
    this.calls.push({ op: 'createAudience', audience: id, count: 0 });
    return { externalAudienceId: id };
  }
  async updateAudience(_ctx: DestinationContext, ref: AudienceRef, spec: Partial<AudienceSpec>) { const a = this.store().get(ref.externalAudienceId); if (a && spec.name) a.name = spec.name; }
  /** Unknown ids (e.g. after a process restart) are recovered lazily — the mock behaves like a destination that remembers. */
  private audience(ref: AudienceRef): MockAudience {
    let a = this.store().get(ref.externalAudienceId);
    if (a?.deleted) throw new DestinationError('mock: audience was deleted', 'NOT_FOUND', false, { code: '100' });
    if (!a) { a = { id: ref.externalAudienceId, name: ref.externalAudienceId, account: ref.externalAccountId, members: new Set(), people: new Map(), deleted: false, recovered: true, createdAt: new Date(), updatedAt: new Date() }; this.store().set(a.id, a); }
    return a;
  }
  /** Restore state for an audience from the platform's own records (worker boot). */
  hydrate(ref: AudienceRef, name: string, members: MemberRecord[]): void {
    const a = this.audience(ref); a.name = name; a.recovered = false;
    for (const m of members) { a.people.set(personKey(m), m.identifiers.map((i) => i.hashHex)); for (const i of m.identifiers) a.members.add(i.hashHex); }
  }
  async addMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult> {
    this.maybeFail(meta.batchSeq);
    const a = this.audience(ref);
    this.calls.push({ op: 'addMembers', audience: a.id, count: members.length, seq: meta.batchSeq, dryRun: ctx.dryRun });
    if (ctx.dryRun) return { received: members.length, invalid: 0, externalRef: meta.sessionId, summary: { validate_only: true } };
    let invalid = 0;
    for (const m of members) {
      const ok: string[] = [];
      for (const id of m.identifiers) {
        if (this.failures.invalidFraction && parseInt(id.hashHex.slice(0, 2), 16) / 255 < this.failures.invalidFraction) { invalid++; continue; }
        a.members.add(id.hashHex); ok.push(id.hashHex);
      }
      if (ok.length) a.people.set(personKey(m), ok);
    }
    a.updatedAt = new Date();
    return { received: members.length, invalid, externalRef: meta.sessionId, summary: { num_received: members.length, num_invalid_entries: invalid, session_id: meta.sessionId, batch_seq: meta.batchSeq } };
  }
  async removeMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult> {
    this.maybeFail(meta.batchSeq);
    const a = this.audience(ref);
    this.calls.push({ op: 'removeMembers', audience: a.id, count: members.length, seq: meta.batchSeq, dryRun: ctx.dryRun });
    if (ctx.dryRun) return { received: members.length, invalid: 0, externalRef: meta.sessionId };
    for (const m of members) { a.people.delete(personKey(m)); for (const id of m.identifiers) a.members.delete(id.hashHex); }
    a.updatedAt = new Date();
    return { received: members.length, invalid: 0, externalRef: meta.sessionId, summary: { num_received: members.length } };
  }
  async deleteAudience(_ctx: DestinationContext, ref: AudienceRef) { const a = this.store().get(ref.externalAudienceId); if (a) { a.deleted = true; } this.calls.push({ op: 'deleteAudience', audience: ref.externalAudienceId, count: 0 }); }
  async getStatus(_ctx: DestinationContext, ref: AudienceRef): Promise<AudienceStatus> {
    const a = this.audience(ref);
    // a person "matches" when any of their identifiers matches (~70% per identifier, deterministic by hash byte)
    const matched = [...a.people.values()].filter((hs) => hs.some((h) => parseInt(h.slice(0, 2), 16) < 0xb3)).length;
    const people = a.people.size;
    if (this.capabilities.matchReporting === 'range') {
      return { externalAudienceId: a.id, approximateLower: Math.floor(matched * 0.9), approximateUpper: Math.min(people, Math.ceil(matched * 1.1)), deliveryStatus: matched >= 100 ? 'active' : 'too_small', operationStatus: 'normal', raw: { people, identifiers: a.members.size, recovered: a.recovered } };
    }
    return { externalAudienceId: a.id, approximateCount: matched, matchRate: people ? Math.round((matched / people) * 10000) / 100 : null, deliveryStatus: matched >= 100 ? 'ELIGIBLE' : 'TOO_SMALL', raw: { size_for_display: matched, people, identifiers: a.members.size, recovered: a.recovered } };
  }
  /** test helper */
  membersOf(externalAudienceId: string): Set<string> { return this.store().get(externalAudienceId)?.members ?? new Set(); }
}

export class MockMetaAdapter extends MockDestinationAdapter { constructor() { super('MOCK_META', 'META'); } }
export class MockGoogleAdapter extends MockDestinationAdapter { constructor() { super('MOCK_GOOGLE', 'GOOGLE'); } }
