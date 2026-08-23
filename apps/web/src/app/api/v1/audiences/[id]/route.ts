import { api, body } from '@/server/api';
import { ctx } from '@/server/context';
import { ApiSchemas, describeRule, parseRuleDefinition, TEMPLATE_MAP } from '@aap/core';
export const GET = api({ permission: 'audiences:read' }, async ({ principal, params }) => {
  const c = ctx(); const org = principal.organizationId; const id = params.id!;
  const aud = await c.audiences.getOrThrow(org, id);
  const [rules, exclusions, excludedBy, destinations, stats, runs, summary, campaigns] = await Promise.all([
    c.db.selectFrom('audience_rules').select(['version', 'definition', 'compiled_sql', 'created_at']).where('audience_id', '=', id).orderBy('version', 'desc').limit(10).execute(),
    c.db.selectFrom('audience_exclusions as x').innerJoin('audiences as a', 'a.id', 'x.excluded_audience_id').select(['a.id', 'a.name', 'a.member_count']).where('x.audience_id', '=', id).execute(),
    c.db.selectFrom('audience_exclusions as x').innerJoin('audiences as a', 'a.id', 'x.audience_id').select(['a.id', 'a.name']).where('x.excluded_audience_id', '=', id).execute(),
    c.db.selectFrom('audience_destinations as ad').innerJoin('destination_accounts as da', 'da.id', 'ad.destination_account_id').innerJoin('destinations as d', 'd.id', 'da.destination_id')
      .select(['ad.id', 'ad.status', 'ad.sync_mode', 'ad.sync_schedule', 'ad.external_audience_id', 'ad.external_audience_name', 'ad.last_synced_at', 'ad.next_sync_at', 'ad.last_error', 'ad.source_count', 'ad.eligible_count', 'ad.submitted_count', 'ad.matched_count', 'ad.matched_lower', 'ad.matched_upper', 'ad.match_rate', 'ad.platform_status', 'd.type as destination_type', 'd.name as destination_name', 'da.name as account_name', 'da.external_account_id', 'da.id as destination_account_id']).where('ad.audience_id', '=', id).where('ad.status', '<>', 'DELETED').execute(),
    c.db.selectFrom('audience_stats_daily').select(['day', 'member_count', 'entered', 'exited', 'eligible_count']).where('audience_id', '=', id).orderBy('day').limit(90).execute(),
    c.db.selectFrom('audience_eval_runs').select(['id', 'mode', 'status', 'candidates', 'entered', 'exited', 'duration_ms', 'started_at', 'finished_at', 'error', 'rule_version']).where('audience_id', '=', id).orderBy('started_at', 'desc').limit(15).execute(),
    c.audiences.summarize(org, [id]),
    c.measurement.audienceCampaignMetrics(org, id, new Date(Date.now() - 30 * 86400_000), new Date()),
  ]);
  const current = rules.find((r) => r.version === aud.current_rule_version);
  const template = aud.template_key ? TEMPLATE_MAP.get(aud.template_key) : undefined;
  return { audience: { ...aud, distribution_policy: aud.distribution_policy, recommendation: aud.recommendation ?? template?.recommendation ?? null }, summary: summary[0] ?? null,
    rule: current ? { version: current.version, definition: current.definition, sql: current.compiled_sql, description: describeRule(parseRuleDefinition(current.definition)) } : null,
    ruleHistory: rules.map((r) => ({ version: r.version, created_at: r.created_at, description: describeRule(parseRuleDefinition(r.definition)) })),
    exclusions, excludedBy, destinations, stats, runs, campaigns30d: campaigns };
});
export const PATCH = api({ permission: 'audiences:write' }, async ({ principal, params, req }) => { await ctx().audiences.update(principal, params.id!, await body(req, ApiSchemas.audienceUpdate)); return { ok: true }; });
export const DELETE = api({ permission: 'audiences:delete' }, async ({ principal, params }) => { await ctx().audiences.update(principal, params.id!, { status: 'ARCHIVED' }); return { ok: true }; });
