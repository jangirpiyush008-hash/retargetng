import { createHmac } from 'node:crypto';
import type { AdapterAccount, AudienceRef, AudienceSpec, AudienceStatus, BatchMeta, BatchResult, DestinationAdapter, DestinationCapabilities, DestinationContext, MemberRecord } from '../types.js';
import { DestinationError, type DestinationErrorKind } from '../types.js';
import { httpJson } from '../http.js';

/**
 * Meta Marketing API — Custom Audiences (customer list). See docs/09-meta-integration.md.
 * Credentials: ctx.credentialRef → access token (system user). Optional config.app_secret_ref for appsecret_proof.
 */
export class MetaAdapter implements DestinationAdapter {
  static DEFAULT_API_VERSION = 'v25.0';
  readonly type = 'META';
  readonly capabilities: DestinationCapabilities = { hashProfiles: { EMAIL: 'EMAIL_SHA256', PHONE: 'PHONE_DIGITS_SHA256' }, maxBatchSize: 10_000, supportsRemove: true, supportsReplace: true, matchReporting: 'range', minAudienceSize: 100 };

  private base(ctx: DestinationContext) { return `https://graph.facebook.com/${(ctx.config.api_version as string) || MetaAdapter.DEFAULT_API_VERSION}`; }
  private async token(ctx: DestinationContext): Promise<string> {
    if (!ctx.credentialRef) throw new DestinationError('Meta destination has no credential reference', 'AUTH_EXPIRED', false);
    const t = await ctx.secrets.get(ctx.credentialRef);
    if (!t) throw new DestinationError('Meta access token not found in secret store', 'AUTH_EXPIRED', false);
    return t;
  }
  private async auth(ctx: DestinationContext): Promise<Record<string, string>> {
    const access_token = await this.token(ctx);
    const params: Record<string, string> = { access_token };
    const secretRef = ctx.config.app_secret_ref as string | undefined;
    if (secretRef) { const s = await ctx.secrets.get(secretRef); if (s) params.appsecret_proof = createHmac('sha256', s).update(access_token).digest('hex'); }
    return params;
  }
  private async call<T>(ctx: DestinationContext, method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>, operation: string): Promise<T> {
    const auth = await this.auth(ctx);
    const all = new URLSearchParams({ ...params, ...auth });
    const url = `${this.base(ctx)}/${path}` + (method === 'GET' ? `?${all}` : '');
    const r = await httpJson<T>(url, {
      fetchImpl: ctx.fetch, method, destination: 'META', operation,
      headers: method === 'GET' ? undefined : { 'content-type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : all,
      classify: (status, json, headers) => classifyMetaError(status, json, headers),
    });
    return r.json;
  }

  async connect(ctx: DestinationContext) {
    try {
      const me = await this.call<{ data: Array<{ id: string; name: string; account_id: string; currency: string; timezone_name: string; account_status: number }> }>(ctx, 'GET', 'me/adaccounts', { fields: 'id,name,account_id,currency,timezone_name,account_status', limit: '200' }, 'list_ad_accounts');
      const accounts: AdapterAccount[] = (me.data ?? []).map((a) => ({ externalAccountId: a.id, name: a.name, currency: a.currency, timezone: a.timezone_name, metadata: { account_status: a.account_status } }));
      return { ok: true, message: `Connected — ${accounts.length} ad account(s) visible`, accounts };
    } catch (e) {
      if (e instanceof DestinationError) return { ok: false, message: `${e.kind}: ${e.message}`, accounts: [] };
      throw e;
    }
  }
  async validate(ctx: DestinationContext, externalAccountId: string) {
    try {
      const r = await this.call<{ id: string; name: string; account_status: number; tos_accepted?: Record<string, number> }>(ctx, 'GET', externalAccountId, { fields: 'id,name,account_status,tos_accepted' }, 'validate_account');
      const tos = r.tos_accepted ?? {};
      const caTos = Object.keys(tos).some((k) => /custom_audience/i.test(k));
      return { ok: r.account_status === 1, message: r.account_status === 1 ? `Account ${r.name} active${caTos ? '' : ' — verify Custom Audience terms are accepted in Ads Manager'}` : `Account status ${r.account_status}`, details: { account_status: r.account_status, tos_accepted: tos } };
    } catch (e) { if (e instanceof DestinationError) return { ok: false, message: `${e.kind}: ${e.message}` }; throw e; }
  }
  async createAudience(ctx: DestinationContext, spec: AudienceSpec) {
    const r = await this.call<{ id: string }>(ctx, 'POST', `${spec.externalAccountId}/customaudiences`, {
      name: spec.name, subtype: 'CUSTOM', description: spec.description ?? 'Managed by Audience Activation Platform',
      customer_file_source: (ctx.config.customer_file_source as string) || 'USER_PROVIDED_ONLY',
    }, 'create_audience');
    return { externalAudienceId: r.id };
  }
  async updateAudience(ctx: DestinationContext, ref: AudienceRef, spec: Partial<AudienceSpec>) {
    const params: Record<string, string> = {};
    if (spec.name) params.name = spec.name; if (spec.description) params.description = spec.description;
    if (Object.keys(params).length) await this.call(ctx, 'POST', ref.externalAudienceId, params, 'update_audience');
  }
  private payload(members: MemberRecord[]) {
    const data = members.map((m) => {
      const e = m.identifiers.find((i) => i.kind === 'EMAIL')?.hashHex ?? '';
      const p = m.identifiers.find((i) => i.kind === 'PHONE')?.hashHex ?? '';
      return [e, p];
    });
    return JSON.stringify({ schema: ['EMAIL', 'PHONE'], data });
  }
  private session(meta: BatchMeta) {
    return JSON.stringify({ session_id: sessionIdToNumeric(meta.sessionId), batch_seq: meta.batchSeq, last_batch_flag: meta.isLast, ...(meta.estimatedTotal ? { estimated_num_total: meta.estimatedTotal } : {}) });
  }
  async addMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult> {
    if (ctx.dryRun) return { received: members.length, invalid: 0, externalRef: meta.sessionId, summary: { dry_run: true } };
    const r = await this.call<{ audience_id: string; session_id: string; num_received: number; num_invalid_entries: number }>(ctx, 'POST', `${ref.externalAudienceId}/users`, { payload: this.payload(members), session: this.session(meta) }, 'add_users');
    return { received: r.num_received ?? members.length, invalid: r.num_invalid_entries ?? 0, externalRef: String(r.session_id ?? meta.sessionId), summary: { num_received: r.num_received, num_invalid_entries: r.num_invalid_entries } };
  }
  async removeMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult> {
    if (ctx.dryRun) return { received: members.length, invalid: 0, externalRef: meta.sessionId, summary: { dry_run: true } };
    const r = await this.call<{ num_received: number; num_invalid_entries: number; session_id: string }>(ctx, 'DELETE', `${ref.externalAudienceId}/users`, { payload: this.payload(members), session: this.session(meta) }, 'remove_users');
    return { received: r.num_received ?? members.length, invalid: r.num_invalid_entries ?? 0, externalRef: String(r.session_id ?? meta.sessionId), summary: { num_received: r.num_received, num_invalid_entries: r.num_invalid_entries } };
  }
  async deleteAudience(ctx: DestinationContext, ref: AudienceRef) { await this.call(ctx, 'DELETE', ref.externalAudienceId, {}, 'delete_audience'); }
  async getStatus(ctx: DestinationContext, ref: AudienceRef): Promise<AudienceStatus> {
    const r = await this.call<{ id: string; approximate_count_lower_bound?: number; approximate_count_upper_bound?: number; delivery_status?: { code: number; description: string }; operation_status?: { code: number; description: string }; time_updated?: number }>(
      ctx, 'GET', ref.externalAudienceId, { fields: 'id,name,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_updated' }, 'get_audience');
    return { externalAudienceId: r.id, approximateLower: r.approximate_count_lower_bound ?? null, approximateUpper: r.approximate_count_upper_bound ?? null,
      deliveryStatus: r.delivery_status?.description ?? null, operationStatus: r.operation_status?.description ?? null, raw: { delivery_code: r.delivery_status?.code, operation_code: r.operation_status?.code, time_updated: r.time_updated } };
  }
}

/** Meta's session_id must be a 64-bit integer; derive one deterministically from our uuid. */
function sessionIdToNumeric(s: string): number {
  let h = 0n; for (const ch of s) h = (h * 131n + BigInt(ch.charCodeAt(0))) % 9007199254740991n; return Number(h);
}

/** Map Graph API error envelopes to DestinationError kinds (see docs/09). */
export function classifyMetaError(status: number, json: unknown, headers: Headers): DestinationError | null {
  const err = (json as { error?: { code?: number; error_subcode?: number; message?: string; type?: string; is_transient?: boolean } })?.error;
  if (status < 400 && !err) return null;
  const code = err?.code ?? 0, sub = err?.error_subcode;
  let kind: DestinationErrorKind = 'UNKNOWN'; let retryable = false; let retryAfterMs: number | undefined;
  if (code === 190 || code === 102) { kind = 'AUTH_EXPIRED'; }
  else if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014) || status === 429) {
    kind = 'RATE_LIMITED'; retryable = true;
    const usage = headers.get('x-business-use-case-usage') || headers.get('x-app-usage');
    retryAfterMs = parseUsageHeader(usage) ?? 60_000;
  }
  else if ([200, 10, 294, 3].includes(code) || (code >= 200 && code <= 299)) kind = 'PERMISSION_DENIED';
  else if (code === 100 || code === 2654 || (sub && sub >= 1870000 && sub < 1880000) || status === 400) kind = 'INVALID_REQUEST';
  else if (code === 803 || status === 404) kind = 'NOT_FOUND';
  else if (err?.is_transient || code === 1 || code === 2 || status >= 500) { kind = 'TRANSIENT'; retryable = true; }
  else if (status >= 400) kind = 'INVALID_REQUEST';
  return new DestinationError(`Meta API error ${code}${sub ? `/${sub}` : ''} (${err?.type ?? status})`, kind, retryable, { retryAfterMs, code: String(code), status });
}
function parseUsageHeader(h: string | null): number | undefined {
  if (!h) return undefined;
  try {
    const obj = JSON.parse(h) as Record<string, Array<{ estimated_time_to_regain_access?: number }>> | { estimated_time_to_regain_access?: number };
    const vals = Array.isArray(obj) ? obj : Object.values(obj).flat();
    const mins = (vals as Array<{ estimated_time_to_regain_access?: number }>).map((v) => v?.estimated_time_to_regain_access ?? 0).filter((x) => x > 0);
    return mins.length ? Math.max(...mins) * 60_000 : undefined;
  } catch { return undefined; }
}
