import type { HashProfile } from '../identity/normalize.js';
import type { SecretStore } from '../secrets/index.js';
import type { Logger } from 'pino';

export type DestinationType = 'META' | 'GOOGLE_ADS' | 'MOCK_META' | 'MOCK_GOOGLE' | (string & {});

export type DestinationErrorKind = 'RATE_LIMITED' | 'AUTH_EXPIRED' | 'PERMISSION_DENIED' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'TRANSIENT' | 'UNKNOWN';
export class DestinationError extends Error {
  constructor(message: string, public kind: DestinationErrorKind, public retryable: boolean, public opts: { retryAfterMs?: number; code?: string; status?: number; details?: Record<string, unknown> } = {}) {
    super(message); this.name = 'DestinationError';
  }
}

export interface DestinationCapabilities {
  /** hash profile consumed per identifier kind */
  hashProfiles: Partial<Record<'EMAIL' | 'PHONE', HashProfile>>;
  maxBatchSize: number;
  supportsRemove: boolean;
  supportsReplace: boolean;
  /** how match information is reported back */
  matchReporting: 'exact' | 'range' | 'rate' | 'none';
  /** members below this threshold won't be served (informational) */
  minAudienceSize?: number;
}

export interface DestinationContext {
  destinationId: string;
  organizationId: string;
  type: DestinationType;
  config: Record<string, unknown>;
  credentialRef: string | null;
  secrets: SecretStore;
  fetch: typeof fetch;
  log: Logger;
  /** when true adapters must not mutate anything at the destination (dry run / validateOnly) */
  dryRun?: boolean;
}
export interface AdapterAccount { externalAccountId: string; name: string; currency?: string; timezone?: string; metadata?: Record<string, unknown> }
export interface AudienceRef { externalAudienceId: string; externalAccountId: string }
export interface AudienceSpec { name: string; description?: string; externalAccountId: string }
export interface MemberRecord { customerId: number; identifiers: Array<{ kind: 'EMAIL' | 'PHONE'; hashHex: string }> }
export interface BatchMeta { sessionId: string; batchSeq: number; isLast: boolean; estimatedTotal?: number }
export interface BatchResult { received: number; invalid: number; externalRef?: string | null; summary?: Record<string, unknown>; warnings?: string[] }
export interface AudienceStatus {
  externalAudienceId: string;
  approximateCount?: number | null;
  approximateLower?: number | null;
  approximateUpper?: number | null;
  matchRate?: number | null;
  deliveryStatus?: string | null;
  operationStatus?: string | null;
  raw?: Record<string, unknown>;
}

/**
 * Provider-agnostic destination contract. The distribution engine only ever talks to this
 * interface; adding TikTok/Snap/TTD = one new adapter + registry entry.
 */
export interface DestinationAdapter {
  readonly type: DestinationType;
  readonly capabilities: DestinationCapabilities;
  /** Validate credentials and enumerate selectable ad accounts. */
  connect(ctx: DestinationContext): Promise<{ ok: boolean; message?: string; accounts: AdapterAccount[]; details?: Record<string, unknown> }>;
  /** Validate that a specific account is usable (permissions, TOS). */
  validate(ctx: DestinationContext, externalAccountId: string): Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }>;
  createAudience(ctx: DestinationContext, spec: AudienceSpec): Promise<{ externalAudienceId: string }>;
  updateAudience(ctx: DestinationContext, ref: AudienceRef, spec: Partial<AudienceSpec>): Promise<void>;
  addMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult>;
  removeMembers(ctx: DestinationContext, ref: AudienceRef, members: MemberRecord[], meta: BatchMeta): Promise<BatchResult>;
  deleteAudience(ctx: DestinationContext, ref: AudienceRef): Promise<void>;
  getStatus(ctx: DestinationContext, ref: AudienceRef): Promise<AudienceStatus>;
  /** Refresh/rotate credentials where applicable (e.g. OAuth). */
  refresh?(ctx: DestinationContext): Promise<void>;
}
