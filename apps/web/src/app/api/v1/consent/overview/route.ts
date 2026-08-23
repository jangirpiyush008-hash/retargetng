import { api } from '@/server/api';
import { ctx } from '@/server/context';
import { sql } from 'kysely';
export const GET = api({ permission: 'consent:read' }, async ({ principal }) => {
  const org = principal.organizationId;
  const [breakdown, recent, policies] = await Promise.all([
    ctx().measurement.customerBreakdown(org),
    sql<{ day: string; granted: number; revoked: number }>`SELECT to_char(occurred_at::date,'YYYY-MM-DD') AS day, count(*) FILTER (WHERE event_type='CONSENT_GRANTED')::int AS granted, count(*) FILTER (WHERE event_type='CONSENT_REVOKED')::int AS revoked FROM consent_events WHERE organization_id = ${org} AND occurred_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`.execute(ctx().db),
    ctx().db.selectFrom('compliance_policies').selectAll().where('organization_id', '=', org).orderBy('destination_type').execute(),
  ]);
  return { stats: { lifecycle: breakdown.lifecycle, consent: breakdown.consent, countries: breakdown.countries, computedAt: breakdown.computedAt }, flags: breakdown.flags, recent: recent.rows, policies };
});
