import type { AdapterAccount, AudienceRef, AudienceSpec, AudienceStatus, BatchMeta, BatchResult, DestinationAdapter, DestinationCapabilities, DestinationContext, MemberRecord } from '../types.js';
import { DestinationError } from '../types.js';
import { httpJson, kindFromHttpStatus, retryAfterMs } from '../http.js';

/**
 * Google Ads Customer Match. List management via Google Ads API (UserListService + GAQL);
 * member ingestion via the Data Manager API (required since April 2026). See docs/10.
 *
 * Secrets (SecretStore):
 *   ctx.credentialRef           → JSON { client_id, client_secret, refresh_token }
 *   ctx.config.developer_token_ref → developer token
 * Config: login_customer_id (MCC, optional), api_version (Google Ads API, default v21),
 *         membership_life_span_days (default 540), data_manager_version (default v1).
 */
export class GoogleAdsAdapter implements DestinationAdapter {
  static DEFAULT_ADS_API_VERSION = 'v21';
  static DATA_MANAGER_BASE = 'https://datamanager.googleapis.com';
  readonly type = 'GOOGLE_ADS';
  readonly capabilities: DestinationCapabilities = { hashProfiles: { EMAIL: 'EMAIL_SHA256_GOOGLE', PHONE: 'PHONE_E164_SHA256' }, maxBatchSize: 10_000, supportsRemove: true, supportsReplace: false, matchReporting: 'rate', minAudienceSize: 100 };
  private tokenCache = new Map<string, { token: string; exp: number }>();

  private async oauth(ctx: DestinationContext): Promise<{ client_id: string; client_secret: string; refresh_token: string }> {
    if (!ctx.credentialRef) throw new DestinationError('Google destination has no credential reference', 'AUTH_EXPIRED', false);
    const raw = await ctx.secrets.get(ctx.credentialRef);
    if (!raw) throw new DestinationError('Google OAuth credential not found in secret store', 'AUTH_EXPIRED', false);
    try { return JSON.parse(raw); } catch { throw new DestinationError('Google OAuth credential must be JSON {client_id, client_secret, refresh_token}', 'AUTH_EXPIRED', false); }
  }
  private async accessToken(ctx: DestinationContext, force = false): Promise<string> {
    const key = ctx.credentialRef ?? '';
    const c = this.tokenCache.get(key);
    if (!force && c && c.exp > Date.now() + 60_000) return c.token;
    const o = await this.oauth(ctx);
    const r = await httpJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      fetchImpl: ctx.fetch, method: 'POST', destination: 'GOOGLE_ADS', operation: 'oauth_refresh',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: o.client_id, client_secret: o.client_secret, refresh_token: o.refresh_token }),
      classify: (status, json) => status < 400 ? null : new DestinationError(`OAuth refresh failed (${(json as { error?: string })?.error ?? status})`, status === 400 || status === 401 ? 'AUTH_EXPIRED' : kindFromHttpStatus(status), status >= 500, { status }),
    });
    this.tokenCache.set(key, { token: r.json.access_token, exp: Date.now() + (r.json.expires_in ?? 3600) * 1000 });
    return r.json.access_token;
  }
  async refresh(ctx: DestinationContext) { await this.accessToken(ctx, true); }

  private async adsHeaders(ctx: DestinationContext): Promise<Record<string, string>> {
    const devRef = ctx.config.developer_token_ref as string | undefined;
    const dev = devRef ? await ctx.secrets.get(devRef) : null;
    if (!dev) throw new DestinationError('Google Ads developer token not configured (developer_token_ref)', 'PERMISSION_DENIED', false);
    const h: Record<string, string> = { authorization: `Bearer ${await this.accessToken(ctx)}`, 'developer-token': dev, 'content-type': 'application/json' };
    if (ctx.config.login_customer_id) h['login-customer-id'] = String(ctx.config.login_customer_id).replace(/-/g, '');
    return h;
  }
  private adsBase(ctx: DestinationContext) { return `https://googleads.googleapis.com/${(ctx.config.api_version as string) || GoogleAdsAdapter.DEFAULT_ADS_API_VERSION}`; }
  private dmBase(ctx: DestinationContext) { return `${GoogleAdsAdapter.DATA_MANAGER_BASE}/${(ctx.config.data_manager_version as string) || 'v1'}`; }

  private async adsCall<T>(ctx: DestinationContext, method: 'GET' | 'POST', path: string, body: unknown, operation: string): Promise<T> {
    const call = async () => httpJson<T>(`${this.adsBase(ctx)}/${path}`, { fetchImpl: ctx.fetch, method, destination: 'GOOGLE_ADS', operation, headers: await this.adsHeaders(ctx), body: body ? JSON.stringify(body) : undefined, classify: classifyGoogleError });
    try { return (await call()).json; }
    catch (e) { if (e instanceof DestinationError && e.kind === 'AUTH_EXPIRED') { await this.accessToken(ctx, true); return (await call()).json; } throw e; }
  }
  private async dmCall<T>(ctx: DestinationContext, method: 'GET' | 'POST', path: string, body: unknown, operation: string): Promise<T> {
    const call = async () => httpJson<T>(`${this.dmBase(ctx)}/${path}`, { fetchImpl: ctx.fetch, method, destination: 'GOOGLE_ADS', operation, headers: { authorization: `Bearer ${await this.accessToken(ctx)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, classify: classifyGoogleError });
    try { return (await call()).json; }
    catch (e) { if (e instanceof DestinationError && e.kind === 'AUTH_EXPIRED') { await this.accessToken(ctx, true); return (await call()).json; } throw e; }
  }

  async connect(ctx: DestinationContext) {
    try {
      const r = await this.adsCall<{ resourceNames: string[] }>(ctx, 'GET', 'customers:listAccessibleCustomers', undefined, 'list_customers');
      const accounts: AdapterAccount[] = [];
      for (const rn of r.resourceNames ?? []) {
        const id = rn.split('/')[1]!;
        try {
          const q = await this.adsCall<{ results?: Array<{ customer: { id: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean } }> }>(ctx, 'POST', `customers/${id}/googleAds:search`, { query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer' }, 'customer_info');
          const cst = q.results?.[0]?.customer;
          accounts.push({ externalAccountId: id, name: cst?.descriptiveName ?? id, currency: cst?.currencyCode, timezone: cst?.timeZone, metadata: { manager: cst?.manager ?? false } });
        } catch { accounts.push({ externalAccountId: id, name: id }); }
      }
      return { ok: true, message: `Connected — ${accounts.length} accessible customer(s)`, accounts };
    } catch (e) { if (e instanceof DestinationError) return { ok: false, message: `${e.kind}: ${e.message}`, accounts: [] }; throw e; }
  }
  async validate(ctx: DestinationContext, externalAccountId: string) {
    try {
      // validateOnly Data Manager call proves datamanager scope + account access without mutating
      await this.dmCall(ctx, 'POST', 'audienceMembers:ingest', { destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: externalAccountId }, productDestinationId: '0' }], audienceMembers: [], encoding: 'HEX', validateOnly: true }, 'validate');
      return { ok: true, message: `Account ${externalAccountId} reachable (validateOnly)` };
    } catch (e) {
      if (e instanceof DestinationError) return e.kind === 'INVALID_REQUEST' ? { ok: true, message: 'Account reachable (validation request rejected as expected without members)' } : { ok: false, message: `${e.kind}: ${e.message}` };
      throw e;
    }
  }
  async createAudience(ctx: DestinationContext, spec: AudienceSpec) {
    const r = await this.adsCall<{ results: Array<{ resourceName: string }> }>(ctx, 'POST', `customers/${spec.externalAccountId}/userLists:mutate`, {
      operations: [{ create: { name: spec.name, description: spec.description ?? 'Managed by Audience Activation Platform', membershipStatus: 'OPEN',
        membershipLifeSpan: Number(ctx.config.membership_life_span_days ?? 540), crmBasedUserList: { uploadKeyType: 'CONTACT_INFO', dataSourceType: 'FIRST_PARTY' } } }],
    }, 'create_user_list');
    const rn = r.results?.[0]?.resourceName ?? '';
    return { externalAudienceId: rn.split('/').pop()! };
  }
  async updateAudience(ctx: DestinationContext, ref: AudienceRef, spec: Partial<AudienceSpec>) {
    if (!spec.name && !spec.description) return;
    await this.adsCall(ctx, 'POST', `customers/${ref.externalAccountId}/userLists:mutate`, { operations: [{ update: { resourceName: `customers/${ref.externalAccountId}/userLists/${ref.externalAudienceId}`, name: spec.name, description: spec.description }, updateMask: [spec.name ? 'name' : null, spec.description ? 'description' : null].filter(Boolean).join(',') }] }, 'update_user_list');
  }
  private body(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], validateOnly: boolean) {
    const loginId = ctx.config.login_customer_id ? String(ctx.config.login_customer_id).replace(/-/g, '') : undefined;
    return {
      destinations: [{ reference: 'primary', operatingAccount: { accountType: 'GOOGLE_ADS', accountId: ref.externalAccountId }, ...(loginId ? { loginAccount: { accountType: 'GOOGLE_ADS_MANAGER', accountId: loginId } } : {}), productDestinationId: ref.externalAudienceId }],
      audienceMembers: members.map((m) => ({ userData: { userIdentifiers: m.identifiers.map((i) => (i.kind === 'EMAIL' ? { emailAddress: i.hashHex } : { phoneNumber: i.hashHex })) } })),
      encoding: 'HEX',
      consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
      termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
      validateOnly,
    };
  }
  async addMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult> {
    const r = await this.dmCall<{ requestId?: string; fieldWarnings?: unknown[] }>(ctx, 'POST', 'audienceMembers:ingest', this.body(ctx, ref, members, !!ctx.dryRun), 'ingest_members');
    return { received: members.length, invalid: 0, externalRef: r.requestId ?? meta.sessionId, summary: { request_id: r.requestId, warnings: r.fieldWarnings?.length ?? 0, validate_only: !!ctx.dryRun } };
  }
  async removeMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult> {
    const b = this.body(ctx, ref, members, !!ctx.dryRun) as Record<string, unknown>; delete b.consent; delete b.termsOfService;
    const r = await this.dmCall<{ requestId?: string }>(ctx, 'POST', 'audienceMembers:remove', b, 'remove_members');
    return { received: members.length, invalid: 0, externalRef: r.requestId ?? meta.sessionId, summary: { request_id: r.requestId, validate_only: !!ctx.dryRun } };
  }
  async deleteAudience(ctx: DestinationContext, ref: AudienceRef) {
    await this.adsCall(ctx, 'POST', `customers/${ref.externalAccountId}/userLists:mutate`, { operations: [{ remove: `customers/${ref.externalAccountId}/userLists/${ref.externalAudienceId}` }] }, 'delete_user_list');
  }
  async getStatus(ctx: DestinationContext, ref: AudienceRef): Promise<AudienceStatus> {
    const q = await this.adsCall<{ results?: Array<{ userList: { id: string; sizeForDisplay?: string; sizeForSearch?: string; sizeRangeForDisplay?: string; matchRatePercentage?: string; membershipStatus?: string } }> }>(ctx, 'POST', `customers/${ref.externalAccountId}/googleAds:search`,
      { query: `SELECT user_list.id, user_list.size_for_display, user_list.size_for_search, user_list.size_range_for_display, user_list.match_rate_percentage, user_list.membership_status FROM user_list WHERE user_list.id = ${Number(ref.externalAudienceId)}` }, 'user_list_status');
    const u = q.results?.[0]?.userList;
    const size = u?.sizeForDisplay != null ? Number(u.sizeForDisplay) : null;
    return { externalAudienceId: ref.externalAudienceId, approximateCount: size, matchRate: u?.matchRatePercentage != null ? Number(u.matchRatePercentage) : null, deliveryStatus: u?.sizeRangeForDisplay ?? null, operationStatus: u?.membershipStatus ?? null, raw: { size_for_search: u?.sizeForSearch } };
  }
  /** Data Manager request status (match-rate range per destination). */
  async requestStatus(ctx: DestinationContext, requestId: string) {
    return this.dmCall<{ requestStatusPerDestination?: Array<{ requestStatus: string; errorInfo?: unknown; audienceMembersIngestionStatus?: { userDataIngestionStatus?: { recordCount?: string; userIdentifierCount?: string; uploadMatchRateRange?: string } } }> }>(ctx, 'GET', `requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`, undefined, 'request_status');
  }
}

export function classifyGoogleError(status: number, json: unknown, headers: Headers): DestinationError | null {
  if (status < 400) return null;
  const err = (json as { error?: { status?: string; message?: string; code?: number; details?: unknown[] } })?.error;
  const grpc = err?.status;
  const retryableGrpc = ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL', 'UNKNOWN', 'ABORTED', 'RESOURCE_EXHAUSTED'];
  let kind = kindFromHttpStatus(status);
  if (grpc === 'UNAUTHENTICATED') kind = 'AUTH_EXPIRED';
  else if (grpc === 'PERMISSION_DENIED') kind = 'PERMISSION_DENIED';
  else if (grpc === 'RESOURCE_EXHAUSTED') kind = 'RATE_LIMITED';
  else if (grpc === 'INVALID_ARGUMENT' || grpc === 'FAILED_PRECONDITION') kind = 'INVALID_REQUEST';
  else if (grpc === 'NOT_FOUND') kind = 'NOT_FOUND';
  else if (grpc && retryableGrpc.includes(grpc)) kind = 'TRANSIENT';
  const retryable = kind === 'RATE_LIMITED' || kind === 'TRANSIENT';
  return new DestinationError(`Google API error ${status}${grpc ? ` ${grpc}` : ''}`, kind, retryable, { retryAfterMs: retryAfterMs(headers), code: grpc ?? String(status), status, details: err?.details ? { n: err.details.length } : undefined });
}
