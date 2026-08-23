'use client';
import Link from 'next/link';
import { Activity, ArrowUpRight, Target, Users } from 'lucide-react';
import { useApi } from '@/lib/api-client';
import { fmtCompact, fmtMoney, fmtNum, fmtPct, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, Stat, StatusBadge, DestinationIcon, Funnel, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Dash { overview: any; audiences: any[]; quality: { score: number; computedAt: string } | null; queue: Array<{ queue: string; pending: number; running: number; dead: number }>; recentJobs: any[] }

export default function DashboardPage() {
  const { data, error, loading } = useApi<Dash>('/api/v1/dashboard', { refreshMs: 30_000 });
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <div className="space-y-4"><PageHeader title="Dashboard" /><LoadingRows n={8} /></div>;
  const o = data.overview; const d = o.destinations as Record<string, any>;
  const meta = d.META ?? d.MOCK_META; const google = d.GOOGLE_ADS ?? d.MOCK_GOOGLE;
  return (<div>
    <PageHeader title="Dashboard" description="Source customers are not reach. Every number below is labelled by funnel stage: source → eligible → submitted → matched." actions={<Button asChild><Link href="/audiences/new">New audience</Link></Button>} />
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      <Stat label="Total customers" value={fmtCompact(o.customers.total)} hint="Source database" />
      <Stat label="Eligible customers" value={fmtCompact(o.customers.eligible)} hint={`${fmtPct((o.customers.eligible / Math.max(1, o.customers.total)) * 100)} consented & identifiable`} tone="success" />
      <Stat label="In audiences" value={fmtCompact(o.customers.inAudiences)} hint="Distinct customers in ≥1 audience" />
      <Stat label="Active audiences" value={fmtNum(o.audiences.active)} hint={`${fmtNum(o.audiences.total)} total`} />
      <Stat label="Meta audiences" value={fmtNum(meta?.audiences ?? 0)} hint={meta ? `${meta.errors} failed · synced ${timeAgo(meta.last_sync_at)}` : 'Not connected'} tone={meta?.errors ? 'warning' : 'default'} />
      <Stat label="Google audiences" value={fmtNum(google?.audiences ?? 0)} hint={google ? `${google.errors} failed · synced ${timeAgo(google.last_sync_at)}` : 'Not connected'} tone={google?.errors ? 'warning' : 'default'} />
      <Stat label="Sync health" value={<span className="flex items-center gap-2 text-base"><StatusBadge status={o.sync.health} /></span>} hint={`${o.sync.success24h} ok · ${o.sync.failed24h} failed · ${o.sync.running} running (24h)`} />
      <Stat label="Activated today" value={fmtCompact(o.sync.activatedToday)} hint="Members added at destinations" tone="success" />
      <Stat label="Removed today" value={fmtCompact(o.sync.removedToday)} hint="Purchases, opt-outs, exits" />
      <Stat label="Estimated reach" value={fmtCompact(o.reach.matched)} hint={`${fmtCompact(o.reach.submitted)} submitted · match ${fmtPct(o.reach.matchRate)}`} />
      <Stat label="Revenue (30d)" value={fmtMoney(o.campaigns30d.revenue)} hint={`Spend ${fmtMoney(o.campaigns30d.spend)}`} />
      <Stat label="ROAS / CVR" value={<span>{o.campaigns30d.roas ? o.campaigns30d.roas.toFixed(2) + 'x' : '—'}</span>} hint={`CVR ${fmtPct(o.campaigns30d.cvr)} · ${fmtCompact(o.campaigns30d.conversions)} conversions`} />
    </div>

    <div className="mt-6 grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-center justify-between"><div><CardTitle>Audiences</CardTitle><CardDescription>Members are rule matches; eligible is after consent, suppression and exclusions.</CardDescription></div><Button variant="ghost" size="sm" asChild><Link href="/audiences">View all <ArrowUpRight className="h-3.5 w-3.5" /></Link></Button></CardHeader>
        <CardContent className="p-0">
          <Table><TableHeader><TableRow><TableHead className="pl-5">Audience</TableHead><TableHead className="text-right">Members</TableHead><TableHead className="text-right">Eligible</TableHead><TableHead className="text-right">+/− today</TableHead><TableHead>Destinations</TableHead><TableHead>Match</TableHead><TableHead>Last sync</TableHead></TableRow></TableHeader>
            <TableBody>{data.audiences.map((a) => (<TableRow key={a.id}>
              <TableCell className="pl-5"><Link href={`/audiences/${a.id}`} className="font-medium hover:underline">{a.name}</Link><div className="text-[11px] text-muted-foreground">{a.slug} · <StatusBadge status={a.status} /></div></TableCell>
              <TableCell className="num text-right">{fmtNum(a.member_count)}</TableCell><TableCell className="num text-right">{fmtNum(a.eligible_count)}</TableCell>
              <TableCell className="num text-right"><span className="text-success">+{fmtCompact(a.added_today)}</span> / <span className="text-destructive">−{fmtCompact(a.removed_today)}</span></TableCell>
              <TableCell>{Number(a.destination_count) ? <Badge variant={Number(a.destination_errors) ? 'destructive' : 'success'}>{a.destination_count} active{Number(a.destination_errors) ? ` · ${a.destination_errors} error` : ''}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
              <TableCell className="num">{fmtPct(a.match_rate)}</TableCell><TableCell className="text-xs text-muted-foreground">{timeAgo(a.last_synced_at)}</TableCell>
            </TableRow>))}</TableBody></Table>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card><CardHeader><CardTitle>Reach funnel</CardTitle><CardDescription>Across active destination audiences</CardDescription></CardHeader>
          <CardContent><Funnel steps={[{ label: 'Source customers', value: o.customers.total }, { label: 'Eligible (consent)', value: o.customers.eligible }, { label: 'Submitted', value: o.reach.submitted }, { label: 'Matched (est.)', value: o.reach.matched }]} /><p className="mt-3 text-[11px] text-muted-foreground">{o.reach.note}</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Consent</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          {[['Granted', o.customers.consent.granted, 'success'], ['Denied', o.customers.consent.denied, 'destructive'], ['Unknown / expired', o.customers.consent.unknown, 'warning']].map(([l, v, t]) => <div key={String(l)} className="flex items-center justify-between"><span className="text-muted-foreground">{String(l)}</span><Badge variant={t as never}>{fmtCompact(Number(v))}</Badge></div>)}
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Suppressed</span><Badge variant="muted">{fmtCompact(o.customers.suppressed)}</Badge></div>
          <div className="flex items-center justify-between border-t pt-2"><span className="text-muted-foreground">Data quality</span><span className="num font-medium">{data.quality ? `${data.quality.score.toFixed(1)} / 100` : '—'}</span></div>
        </CardContent></Card>
      </div>
    </div>

    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2"><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Recent sync jobs</CardTitle><CardDescription>Every synchronization is a job with checkpoints and a full log.</CardDescription></div><Button variant="ghost" size="sm" asChild><Link href="/sync-jobs">All jobs <ArrowUpRight className="h-3.5 w-3.5" /></Link></Button></CardHeader>
        <CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Audience</TableHead><TableHead>Destination</TableHead><TableHead>Trigger</TableHead><TableHead className="text-right">Added</TableHead><TableHead className="text-right">Removed</TableHead><TableHead className="text-right">Failed</TableHead><TableHead>Status</TableHead><TableHead>When</TableHead></TableRow></TableHeader>
          <TableBody>{data.recentJobs.map((j) => (<TableRow key={j.id}><TableCell className="pl-5"><Link href={`/sync-jobs/${j.id}`} className="hover:underline">{j.audience_name}</Link></TableCell><TableCell><span className="flex items-center gap-1.5"><DestinationIcon type={j.destination_type} />{titleCase(j.destination_type)}</span></TableCell><TableCell className="text-xs">{titleCase(j.trigger)} · {j.mode}</TableCell><TableCell className="num text-right text-success">+{fmtNum(j.added)}</TableCell><TableCell className="num text-right text-destructive">−{fmtNum(j.removed)}</TableCell><TableCell className="num text-right">{fmtNum(j.failed)}</TableCell><TableCell><StatusBadge status={j.status} /></TableCell><TableCell className="text-xs text-muted-foreground">{timeAgo(j.finished_at ?? j.started_at)}</TableCell></TableRow>))}
          {!data.recentJobs.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No sync jobs yet — activate an audience to a destination.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
      <Card><CardHeader><CardTitle>Pipeline</CardTitle><CardDescription>Queue depth per worker queue</CardDescription></CardHeader><CardContent className="space-y-2 text-xs">
        {data.queue.length ? data.queue.map((q) => <div key={q.queue} className="flex items-center justify-between"><span className="font-mono text-muted-foreground">{q.queue}</span><span className="num">{q.pending} pending · {q.running} running{q.dead ? <span className="text-destructive"> · {q.dead} dead</span> : null}</span></div>) : <div className="text-muted-foreground">Queues are empty — the worker is idle.</div>}
        <div className="border-t pt-2 text-[11px] text-muted-foreground">Incremental evaluation touches only changed customers and time-boundary crossers; delta sync sends only adds/removes.</div>
        <div className="flex gap-2 pt-1"><Button variant="outline" size="xs" asChild><Link href="/customers"><Users className="h-3 w-3" />Customers</Link></Button><Button variant="outline" size="xs" asChild><Link href="/audiences"><Target className="h-3 w-3" />Audiences</Link></Button><Button variant="outline" size="xs" asChild><Link href="/analytics"><Activity className="h-3 w-3" />Analytics</Link></Button></div>
      </CardContent></Card>
    </div>
  </div>);
}
