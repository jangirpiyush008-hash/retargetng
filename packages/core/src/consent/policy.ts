import { z } from 'zod';
import { sql, type RawBuilder } from 'kysely';

/**
 * Compliance policy — configurable per organization × destination type (× region).
 * Compiled to SQL so eligibility is computed in the database at scale, and evaluated in
 * TypeScript for single-customer inspection ("why is this customer ineligible?").
 */
export const CONSENT_STATUSES = ['GRANTED', 'DENIED', 'UNKNOWN', 'EXPIRED'] as const;
export const CONSENT_FLAGS = ['marketing_allowed', 'advertising_personalization_allowed', 'data_sharing_allowed'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export type ConsentFlag = (typeof CONSENT_FLAGS)[number];

const RegionOverrideSchema = z.object({
  countries: z.array(z.string().length(2)).min(1),
  blocked: z.boolean().optional(),
  allowConsentStatus: z.array(z.enum(CONSENT_STATUSES)).optional(),
  requireFlags: z.array(z.enum(CONSENT_FLAGS)).optional(),
});

export const CompliancePolicyRulesSchema = z.object({
  version: z.literal(1).default(1),
  /** consent statuses that are acceptable (default: GRANTED only) */
  allowConsentStatus: z.array(z.enum(CONSENT_STATUSES)).default(['GRANTED']),
  /** boolean flags that must be true */
  requireFlags: z.array(z.enum(CONSENT_FLAGS)).default(['advertising_personalization_allowed', 'data_sharing_allowed']),
  /** consent older than this is treated as EXPIRED (null = never expires) */
  consentMaxAgeDays: z.number().int().min(1).nullable().default(null),
  blockedCountries: z.array(z.string().length(2)).default([]),
  regionOverrides: z.array(RegionOverrideSchema).default([]),
  /** identifier requirement for this destination */
  requireIdentifier: z.enum(['ANY', 'EMAIL', 'PHONE', 'BOTH']).default('ANY'),
  requireValidIdentifier: z.boolean().default(true),
  excludeCustomerStatuses: z.array(z.string()).default([]),
  /** ad-fatigue rules (only applied when exposure data exists) */
  fatigue: z.object({
    maxFrequency7d: z.number().min(0).nullable().default(null),
    suppressHoursAfterImpression: z.number().int().min(0).nullable().default(null),
    suppressDaysAfterConversion: z.number().int().min(0).nullable().default(null),
  }).default({}),
});
export type CompliancePolicyRules = z.infer<typeof CompliancePolicyRulesSchema>;

export const DEFAULT_POLICY: CompliancePolicyRules = CompliancePolicyRulesSchema.parse({});

export function parsePolicy(input: unknown): CompliancePolicyRules {
  return CompliancePolicyRulesSchema.parse(input ?? {});
}

export type IneligibilityReason =
  | 'DELETED' | 'SUPPRESSED' | 'CONSENT_DENIED' | 'CONSENT_UNKNOWN' | 'CONSENT_EXPIRED'
  | 'MISSING_FLAG' | 'BLOCKED_COUNTRY' | 'NO_IDENTIFIER' | 'INVALID_IDENTIFIER' | 'CUSTOMER_STATUS' | 'HOLDOUT' | 'EXCLUDED_BY_AUDIENCE' | 'FATIGUE';

export interface CustomerConsentView {
  deleted: boolean; suppressed: boolean; consent_status: ConsentStatus; consent_updated_at: Date | null;
  marketing_allowed: boolean; advertising_personalization_allowed: boolean; data_sharing_allowed: boolean;
  country: string | null; status: string;
  email_hash: Buffer | null; phone_hash: Buffer | null; email_valid: boolean | null; phone_valid: boolean | null;
}

function effectiveFor(policy: CompliancePolicyRules, country: string | null) {
  const ov = country ? policy.regionOverrides.find((o) => o.countries.includes(country.toUpperCase())) : undefined;
  return {
    blocked: ov?.blocked ?? policy.blockedCountries.includes((country ?? '').toUpperCase()),
    allowConsentStatus: ov?.allowConsentStatus ?? policy.allowConsentStatus,
    requireFlags: ov?.requireFlags ?? policy.requireFlags,
  };
}

/** TypeScript evaluator — must stay consistent with compilePolicyPredicate(). Returns reasons (empty = eligible). */
export function evaluatePolicy(policy: CompliancePolicyRules, c: CustomerConsentView, now: Date): IneligibilityReason[] {
  const reasons: IneligibilityReason[] = [];
  if (c.deleted) reasons.push('DELETED');
  if (c.suppressed) reasons.push('SUPPRESSED');
  const eff = effectiveFor(policy, c.country);
  if (eff.blocked) reasons.push('BLOCKED_COUNTRY');
  let status: ConsentStatus = c.consent_status;
  if (status === 'GRANTED' && policy.consentMaxAgeDays != null && c.consent_updated_at &&
      now.getTime() - c.consent_updated_at.getTime() > policy.consentMaxAgeDays * 86400_000) status = 'EXPIRED';
  if (!eff.allowConsentStatus.includes(status)) {
    reasons.push(status === 'DENIED' ? 'CONSENT_DENIED' : status === 'EXPIRED' ? 'CONSENT_EXPIRED' : 'CONSENT_UNKNOWN');
  }
  for (const f of eff.requireFlags) if (!c[f]) { reasons.push('MISSING_FLAG'); break; }
  if (policy.excludeCustomerStatuses.includes(c.status)) reasons.push('CUSTOMER_STATUS');
  const emailOk = !!c.email_hash && (!policy.requireValidIdentifier || c.email_valid !== false);
  const phoneOk = !!c.phone_hash && (!policy.requireValidIdentifier || c.phone_valid !== false);
  const idOk = policy.requireIdentifier === 'ANY' ? emailOk || phoneOk : policy.requireIdentifier === 'EMAIL' ? emailOk
    : policy.requireIdentifier === 'PHONE' ? phoneOk : emailOk && phoneOk;
  if (!idOk) reasons.push(c.email_hash || c.phone_hash ? 'INVALID_IDENTIFIER' : 'NO_IDENTIFIER');
  return reasons;
}

/**
 * SQL predicate over alias `c` (customers). `now` is parameterized.
 * Mirrors evaluatePolicy(); cross-checked by tests.
 */
export function compilePolicyPredicate(policy: CompliancePolicyRules, now: Date): RawBuilder<boolean> {
  const parts: RawBuilder<unknown>[] = [sql`NOT c.deleted`, sql`NOT c.suppressed`];
  // effective consent status (with expiry)
  const statusExpr = policy.consentMaxAgeDays != null
    ? sql`(CASE WHEN c.consent_status = 'GRANTED' AND c.consent_updated_at IS NOT NULL AND c.consent_updated_at < ${now}::timestamptz - make_interval(days => ${policy.consentMaxAgeDays}) THEN 'EXPIRED' ELSE c.consent_status END)`
    : sql`c.consent_status`;
  const flagsExpr = (flags: readonly string[]) => flags.length ? sql.join(flags.map((f) => sql.raw(`c.${f}`)), sql.raw(' AND ')) : sql`true`;
  // region-specific branches
  const branches: RawBuilder<unknown>[] = [];
  for (const ov of policy.regionOverrides) {
    const cond = sql`upper(c.country) = ANY(${ov.countries.map((x) => x.toUpperCase())}::text[])`;
    const body = ov.blocked ? sql`false`
      : sql`(${statusExpr} = ANY(${ov.allowConsentStatus ?? policy.allowConsentStatus}::text[]) AND ${flagsExpr(ov.requireFlags ?? policy.requireFlags)})`;
    branches.push(sql`WHEN ${cond} THEN ${body}`);
  }
  const defaultBody = sql`(${policy.blockedCountries.length ? sql`NOT (upper(coalesce(c.country,'')) = ANY(${policy.blockedCountries.map((x) => x.toUpperCase())}::text[]))` : sql`true`}
      AND ${statusExpr} = ANY(${policy.allowConsentStatus}::text[]) AND ${flagsExpr(policy.requireFlags)})`;
  parts.push(branches.length ? sql`(CASE ${sql.join(branches, sql.raw(' '))} ELSE ${defaultBody} END)` : defaultBody);
  if (policy.excludeCustomerStatuses.length) parts.push(sql`NOT (c.status = ANY(${policy.excludeCustomerStatuses}::text[]))`);
  const emailOk = policy.requireValidIdentifier ? sql`(c.email_hash IS NOT NULL AND c.email_valid IS DISTINCT FROM false)` : sql`c.email_hash IS NOT NULL`;
  const phoneOk = policy.requireValidIdentifier ? sql`(c.phone_hash IS NOT NULL AND c.phone_valid IS DISTINCT FROM false)` : sql`c.phone_hash IS NOT NULL`;
  parts.push(policy.requireIdentifier === 'ANY' ? sql`(${emailOk} OR ${phoneOk})` : policy.requireIdentifier === 'EMAIL' ? emailOk
    : policy.requireIdentifier === 'PHONE' ? phoneOk : sql`(${emailOk} AND ${phoneOk})`);
  return sql<boolean>`(${sql.join(parts, sql.raw(' AND '))})`;
}

/**
 * Per-reason CASE expressions for funnel breakdowns (counts of why members are ineligible).
 * Order matters: a customer is attributed to the first matching reason.
 */
export function compilePolicyReasonExpr(policy: CompliancePolicyRules, now: Date): RawBuilder<string | null> {
  const statusExpr = policy.consentMaxAgeDays != null
    ? sql`(CASE WHEN c.consent_status = 'GRANTED' AND c.consent_updated_at IS NOT NULL AND c.consent_updated_at < ${now}::timestamptz - make_interval(days => ${policy.consentMaxAgeDays}) THEN 'EXPIRED' ELSE c.consent_status END)`
    : sql`c.consent_status`;
  const blockedCountries = [...new Set([...policy.blockedCountries, ...policy.regionOverrides.filter((o) => o.blocked).flatMap((o) => o.countries)])].map((x) => x.toUpperCase());
  // region-aware effective allowed statuses / required flags
  const regionCase = <T>(pick: (o: CompliancePolicyRules['regionOverrides'][number] | undefined) => RawBuilder<T>): RawBuilder<T> => {
    const nonBlocked = policy.regionOverrides.filter((o) => !o.blocked);
    if (!nonBlocked.length) return pick(undefined);
    return sql<T>`(CASE ${sql.join(nonBlocked.map((o) => sql`WHEN upper(c.country) = ANY(${o.countries.map((x) => x.toUpperCase())}::text[]) THEN ${pick(o)}`), sql.raw(' '))} ELSE ${pick(undefined)} END)`;
  };
  const allowedExpr = regionCase<string[]>((o) => sql`${(o?.allowConsentStatus ?? policy.allowConsentStatus)}::text[]`);
  const flagsOkExpr = regionCase<boolean>((o) => {
    const flags = o?.requireFlags ?? policy.requireFlags;
    return flags.length ? sql`(${sql.join(flags.map((f) => sql.raw(`c.${f}`)), sql.raw(' AND '))})` : sql`true`;
  });
  const emailOk = policy.requireValidIdentifier ? sql`(c.email_hash IS NOT NULL AND c.email_valid IS DISTINCT FROM false)` : sql`c.email_hash IS NOT NULL`;
  const phoneOk = policy.requireValidIdentifier ? sql`(c.phone_hash IS NOT NULL AND c.phone_valid IS DISTINCT FROM false)` : sql`c.phone_hash IS NOT NULL`;
  const idOk = policy.requireIdentifier === 'ANY' ? sql`(${emailOk} OR ${phoneOk})` : policy.requireIdentifier === 'EMAIL' ? emailOk
    : policy.requireIdentifier === 'PHONE' ? phoneOk : sql`(${emailOk} AND ${phoneOk})`;
  return sql<string | null>`(CASE
    WHEN c.deleted THEN 'DELETED'
    WHEN c.suppressed THEN 'SUPPRESSED'
    WHEN ${blockedCountries.length ? sql`upper(coalesce(c.country,'')) = ANY(${blockedCountries}::text[])` : sql`false`} THEN 'BLOCKED_COUNTRY'
    WHEN NOT (${statusExpr} = ANY(${allowedExpr})) THEN (CASE ${statusExpr} WHEN 'DENIED' THEN 'CONSENT_DENIED' WHEN 'EXPIRED' THEN 'CONSENT_EXPIRED' ELSE 'CONSENT_UNKNOWN' END)
    WHEN NOT ${flagsOkExpr} THEN 'MISSING_FLAG'
    WHEN ${policy.excludeCustomerStatuses.length ? sql`c.status = ANY(${policy.excludeCustomerStatuses}::text[])` : sql`false`} THEN 'CUSTOMER_STATUS'
    WHEN NOT ${idOk} THEN (CASE WHEN c.email_hash IS NULL AND c.phone_hash IS NULL THEN 'NO_IDENTIFIER' ELSE 'INVALID_IDENTIFIER' END)
    ELSE NULL END)`;
}
