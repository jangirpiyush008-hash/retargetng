import { z } from 'zod';
import { RuleDefinitionSchema } from './rules/schema.js';
import { CreateAudienceSchema, UpdateAudienceSchema, ScheduleSchema } from './audience/service.js';
import { InboundEventBatchSchema } from './events/schema.js';
import { CompliancePolicyRulesSchema } from './consent/policy.js';
import { PERMISSIONS } from './rbac/index.js';

/** Single source of truth for API request bodies (validated in route handlers; documented in docs/04-api.md). */
export const ApiSchemas = {
  login: z.object({ email: z.string().email(), password: z.string().min(1) }),
  eventsBatch: z.union([InboundEventBatchSchema, InboundEventBatchSchema.element]),
  customersUpsert: z.object({ customers: z.array(z.object({
    external_customer_id: z.string().min(1).max(128), email: z.string().max(254).optional().nullable(), phone: z.string().max(32).optional().nullable(), country: z.string().length(2).optional().nullable(),
    region: z.string().max(128).optional().nullable(), city: z.string().max(128).optional().nullable(), status: z.string().max(32).optional(), source: z.string().max(64).optional(),
    attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), created_at: z.string().datetime({ offset: true }).optional(),
    consent: z.object({ marketing: z.boolean().optional(), advertising_personalization: z.boolean().optional(), data_sharing: z.boolean().optional() }).optional(),
  })).min(1).max(1000) }),
  audienceCreate: CreateAudienceSchema,
  audienceUpdate: UpdateAudienceSchema,
  audiencePreview: z.object({ definition: RuleDefinitionSchema.optional(), templateKey: z.string().optional(), templateParams: z.record(z.unknown()).optional(), excludeAudienceIds: z.array(z.string().uuid()).optional(), destinationType: z.string().optional(), holdoutPercent: z.number().min(0).max(50).optional() }),
  audienceActivate: z.object({ destinationAccountIds: z.array(z.string().uuid()).min(1), syncMode: z.enum(['INCREMENTAL', 'FULL_REFRESH']).optional(), syncSchedule: ScheduleSchema.optional().nullable(), compliancePolicyId: z.string().uuid().optional().nullable(), dryRun: z.boolean().optional() }),
  audienceSync: z.object({ audienceDestinationId: z.string().uuid().optional(), mode: z.enum(['INCREMENTAL', 'FULL', 'DRY_RUN']).optional() }),
  audienceEvaluate: z.object({ mode: z.enum(['FULL', 'INCREMENTAL', 'RECONCILE']).default('INCREMENTAL') }),
  destinationCreate: z.object({ type: z.string().min(2).max(32), name: z.string().min(2).max(120), config: z.record(z.unknown()).default({}),
    /** credential material is written to the SecretStore and never stored in the DB */
    credential: z.string().min(1).optional(), credentials: z.record(z.string()).optional() }),
  destinationAccountsSelect: z.object({ accounts: z.array(z.object({ externalAccountId: z.string(), name: z.string(), currency: z.string().optional(), timezone: z.string().optional() })).min(1) }),
  suppressionCreate: z.object({ customerId: z.number().int().optional(), email: z.string().optional(), phone: z.string().optional(), reason: z.enum(['UNSUBSCRIBE', 'PRIVACY_REQUEST', 'CUSTOMER_DELETION', 'ADVERTISING_OPT_OUT', 'LEGAL_RESTRICTION', 'INTERNAL_BLACKLIST', 'FRAUD', 'CUSTOMER_COMPLAINT', 'OTHER']), note: z.string().max(500).optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).refine((v) => v.customerId || v.email || v.phone, 'customerId, email or phone required'),
  compliancePolicyUpsert: z.object({ name: z.string().min(2).max(120), destinationType: z.string().nullable().optional(), isDefault: z.boolean().optional(), rules: CompliancePolicyRulesSchema }),
  apiKeyCreate: z.object({ name: z.string().min(2).max(80), scopes: z.array(z.enum(PERMISSIONS)).min(1), expiresAt: z.string().datetime({ offset: true }).optional().nullable() }),
  retentionUpdate: z.object({ policies: z.array(z.object({ dataClass: z.string(), retentionDays: z.number().int().min(1).max(36500) })).min(1) }),
  campaignCreate: z.object({ name: z.string().min(2).max(160), destinationAccountId: z.string().uuid().optional().nullable(), externalCampaignId: z.string().optional(), objective: z.string().optional(), audienceIds: z.array(z.string().uuid()).default([]), startDate: z.string().optional(), endDate: z.string().optional() }),
  campaignMetrics: z.object({ rows: z.array(z.object({ day: z.string(), impressions: z.number().int().min(0).default(0), clicks: z.number().int().min(0).default(0), spend: z.number().min(0).default(0), conversions: z.number().int().min(0).default(0), conversionValue: z.number().min(0).default(0), reach: z.number().int().min(0).optional(), frequency: z.number().min(0).optional() })).min(1).max(1000) }),
  memberInvite: z.object({ email: z.string().email(), name: z.string().min(1).max(120), role: z.enum(['ADMIN', 'MARKETING_MANAGER', 'CAMPAIGN_MANAGER', 'ANALYST', 'VIEW_ONLY']), password: z.string().min(10).max(200) }),
  webhookCreate: z.object({ url: z.string().url(), events: z.array(z.string()).min(1), secret: z.string().min(16).optional() }),
};
export type ApiSchemaKey = keyof typeof ApiSchemas;
