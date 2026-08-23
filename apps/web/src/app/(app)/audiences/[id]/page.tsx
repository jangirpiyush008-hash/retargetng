'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pause, Play, RefreshCw, Trash2, Zap, FlaskConical } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtCompact, fmtDate, fmtMoney, fmtNum, fmtPct, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, Stat, StatusBadge, DestinationIcon, Funnel, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TrendArea, TrendBars } from '@/components/charts/charts';
import { ActivateDialog } from './activate-dialog';

export default function AudienceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const router = useRouter();
  const { data, error, loading, reload } = useApi<any>(`/api/v1/audiences/${id}`, { refreshMs: 20_000 });
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setMsg(null); try { await fn(); setMsg(`${label}: done`); reload(); } catch (e) { setMsg(`${label} failed: ${(e as Error).message}`); } finally { setBusy(null); } };
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows n={10} />;
  const a = data.audience; const s = data.summary ?? {}; const dests: any[] = data.destinations; const rec = a.recommendation;
  const stats = (data.stats as any[]).map((x) => ({ ...x, day: String(x.day).slice(0, 10) }));
  const totalSubmitted = dests.reduce((t, d) => t + Number(d.submitted_count ?? 0), 0); const totalMatched = dests.reduce((t, d) => t + Number(d.matched_count ?? 0), 0);
  return (<div>
    <PageHeader eyebrow={<Link href="/audiences" className="hover:underline">Audiences</Link>} title={<span className="flex items-center gap-3">{a.name}<StatusBadge status={a.status} /></span>} description={<span>{a.description || data.rule?.description}</span>}
      actions={<>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act('Evaluate', () => apiFetch(`/api/v1/audiences/${id}/evaluate`, { method: 'POST', json: { mode: 'INCREMENTAL' } }))}><RefreshCw className="h-4 w-4" />Evaluate now</Button>
        {dests.length > 0 && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act('Sync', () => apiFetch(`/api/v1/audiences/${id}/sync`, { method: 'POST', json: {} }))}><Zap className="h-4 w-4" />Sync now</Button>}
        {a.status === 'ACTIVE' ? <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act('Pause', () => apiFetch(`/api/v1/audiences/${id}`, { method: 'PATCH', json: { status: 'PAUSED' } }))}><Pause className="h-4 w-4" />Pause</Button>
          : <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act('Resume', () => apiFetch(`/api/v1/audiences/${id}`, { method: 'PATCH', json: { status: 'ACTIVE' } }))}><Play className="h-4 w-4" />Activate rules</Button>}
        <ActivateDialog audienceId={id} audienceName={a.name} onDone={reload} />
        <Button variant="ghost" size="sm" className="text-destructive" disabled={!!busy} onClick={() => { if (confirm('Archive this audience? It will be removed from all destinations.')) void act('Archive', async () => { await apiFetch(`/api/v1/audiences/${id}`, { method: 'DELETE' }); router.push('/audiences'); }); }}><Trash2 className="h-4 w-4" /></Button>
      </>} />
    {msg && <div className="mb-3 rounded-md border bg-muted px-3 py-2 text-xs">{msg}</div>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      <Stat label="Members" value={fmtCompact(a.member_count)} hint="Rule matches (source)" />
      <Stat label="Eligible" value={fmtCompact(a.eligible_count)} hint="After consent / suppression / exclusions" tone="success" />
      <Stat label="Submitted" value={fmtCompact(totalSubmitted)} hint="Currently at destinations" />
      <Stat label="Matched (est.)" value={fmtCompact(totalMatched)} hint={`Match ${fmtPct(totalSubmitted ? (totalMatched / totalSubmitted) * 100 : null)}`} />
      <Stat label="Added today" value={<span className="text-success">+{fmtCompact(a.added_today)}</span>} />
      <Stat label="Removed today" value={<span className="text-destructive">−{fmtCompact(a.removed_today)}</span>} />
      <Stat label="Last evaluated" value={<span className="text-base">{timeAgo(a.last_evaluated_at)}</span>} hint={`${titleCase(a.evaluation_schedule)} · next ${timeAgo(a.next_evaluation_at)}`} />
      <Stat label="Revenue / ROAS (30d)" value={<span className="text-base">{fmtMoney(data.campaigns30d.revenue)}</span>} hint={`ROAS ${data.campaigns30d.roas ? data.campaigns30d.roas.toFixed(2) + 'x' : '—'} · ${fmtNum(data.campaigns30d.conversions)} conv.`} />
    </div>

    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2"><CardHeader><CardTitle>Destinations</CardTitle><CardDescription>Sync status per platform. Matched counts come from the platform (Meta reports a range; Google a match rate) — never from the source count.</CardDescription></CardHeader>
        <CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Destination</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Eligible</TableHead><TableHead className="text-right">Submitted</TableHead><TableHead className="text-right">Matched</TableHead><TableHead className="text-right">Match rate</TableHead><TableHead>Last / next sync</TableHead><TableHead /></TableRow></TableHeader><TableBody>
          {dests.map((d) => <TableRow key={d.id}><TableCell className="pl-5"><span className="flex items-center gap-2"><DestinationIcon type={d.destination_type} /><span><div className="font-medium">{d.destination_name}</div><div className="text-[11px] text-muted-foreground">{d.account_name} · {d.external_audience_id ?? 'not created yet'} · {d.sync_mode}</div></span></span></TableCell>
            <TableCell><StatusBadge status={d.status} />{d.last_error && <div className="mt-1 max-w-[220px] truncate text-[10px] text-destructive" title={d.last_error}>{d.last_error}</div>}</TableCell>
            <TableCell className="num text-right">{fmtNum(d.eligible_count)}</TableCell><TableCell className="num text-right">{fmtNum(d.submitted_count)}</TableCell>
            <TableCell className="num text-right">{d.matched_lower != null ? `${fmtCompact(d.matched_lower)}–${fmtCompact(d.matched_upper)}` : fmtNum(d.matched_count)}</TableCell><TableCell className="num text-right">{fmtPct(d.match_rate)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{timeAgo(d.last_synced_at)} / {timeAgo(d.next_sync_at)}</TableCell>
            <TableCell className="space-x-1 text-right">{d.status === 'PAUSED' ? <Button size="xs" variant="outline" onClick={() => act('Resume', () => apiFetch(`/api/v1/audiences/${id}/resume?audienceDestinationId=${d.id}`, { method: 'POST' }))}>Resume</Button> : <Button size="xs" variant="outline" onClick={() => act('Pause', () => apiFetch(`/api/v1/audiences/${id}/pause?audienceDestinationId=${d.id}`, { method: 'POST' }))}>Pause</Button>}<Button size="xs" variant="ghost" className="text-destructive" onClick={() => { if (confirm('Remove this audience from the destination? Members will be removed remotely.')) void act('Remove', () => apiFetch(`/api/v1/audiences/${id}/destinations/${d.id}`, { method: 'DELETE' })); }}>Remove</Button></TableCell></TableRow>)}
          {!dests.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">Not activated on any destination yet — use <b>Activate</b> to preview, dry-run and send.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
      <Card><CardHeader><CardTitle>Rules <Badge variant="muted">v{data.rule?.version}</Badge></CardTitle><CardDescription>Evaluated in Postgres — never in the browser</CardDescription></CardHeader><CardContent className="space-y-3 text-xs">
        <div className="rounded-md bg-muted p-3 font-medium leading-relaxed">{data.rule?.description}</div>
        <details><summary className="cursor-pointer text-muted-foreground">Show compiled SQL</summary><pre className="mt-2 max-h-48 overflow-auto rounded-md bg-foreground/95 p-3 font-mono text-[10px] leading-relaxed text-background">{data.rule?.sql}</pre></details>
        <div><div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Exclusions</div>{data.exclusions.length ? data.exclusions.map((x: any) => <div key={x.id} className="flex justify-between py-0.5"><Link href={`/audiences/${x.id}`} className="hover:underline">− {x.name}</Link><span className="num text-muted-foreground">{fmtCompact(x.member_count)}</span></div>) : <div className="text-muted-foreground">None</div>}</div>
        {data.excludedBy.length > 0 && <div><div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Excluded by</div>{data.excludedBy.map((x: any) => <div key={x.id}><Link href={`/audiences/${x.id}`} className="hover:underline">{x.name}</Link></div>)}</div>}
        <div className="grid grid-cols-2 gap-2 border-t pt-2"><div><div className="text-muted-foreground">Priority</div><div className="font-medium">{a.priority}</div></div><div><div className="text-muted-foreground">Holdout</div><div className="font-medium">{a.holdout_percent}%</div></div><div><div className="text-muted-foreground">Schedule</div><div className="font-medium">{titleCase(a.evaluation_schedule)}</div></div><div><div className="text-muted-foreground">Primary only</div><div className="font-medium">{a.distribution_policy?.primaryOnly ? 'yes' : 'no'}</div></div></div>
        {Number(a.holdout_percent) > 0 && <Button size="sm" variant="outline" asChild className="w-full"><Link href={`/analytics?holdout=${id}`}><FlaskConical className="h-4 w-4" />Incrementality report</Link></Button>}
      </CardContent></Card>
    </div>

    <Tabs defaultValue="trend" className="mt-4">
      <TabsList><TabsTrigger value="trend">Membership trend</TabsTrigger><TabsTrigger value="runs">Evaluation runs</TabsTrigger><TabsTrigger value="recommendation">Campaign recommendation</TabsTrigger><TabsTrigger value="members">Member sample</TabsTrigger></TabsList>
      <TabsContent value="trend"><div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Members over time</CardTitle></CardHeader><CardContent>{stats.length ? <TrendArea data={stats} series={[{ key: 'member_count', label: 'Members' }]} /> : <div className="text-xs text-muted-foreground">No history yet</div>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Added vs removed per day</CardTitle></CardHeader><CardContent>{stats.length ? <TrendBars data={stats} series={[{ key: 'entered', label: 'Added', color: 'hsl(var(--success))' }, { key: 'exited', label: 'Removed', color: 'hsl(var(--destructive))' }]} /> : <div className="text-xs text-muted-foreground">No history yet</div>}</CardContent></Card>
      </div></TabsContent>
      <TabsContent value="runs"><Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Started</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Candidates</TableHead><TableHead className="text-right">Entered</TableHead><TableHead className="text-right">Exited</TableHead><TableHead className="text-right">Duration</TableHead><TableHead>Rule</TableHead></TableRow></TableHeader><TableBody>
        {data.runs.map((r: any) => <TableRow key={r.id}><TableCell className="pl-5 text-xs">{fmtDate(r.started_at)}</TableCell><TableCell><Badge variant="outline">{r.mode}</Badge></TableCell><TableCell><StatusBadge status={r.status} />{r.error && <div className="text-[10px] text-destructive">{r.error}</div>}</TableCell><TableCell className="num text-right">{fmtNum(r.candidates)}</TableCell><TableCell className="num text-right text-success">+{fmtNum(r.entered)}</TableCell><TableCell className="num text-right text-destructive">−{fmtNum(r.exited)}</TableCell><TableCell className="num text-right">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</TableCell><TableCell className="text-xs">v{r.rule_version}</TableCell></TableRow>)}
        {!data.runs.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No evaluation runs yet.</TableCell></TableRow>}</TableBody></Table></CardContent></Card></TabsContent>
      <TabsContent value="recommendation">{rec ? (<Card><CardContent className="grid gap-4 p-5 md:grid-cols-2"><div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Purpose</div><div className="text-sm font-medium">{rec.purpose}</div></div><div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Recommended channels</div><div className="flex gap-1">{rec.channels.map((c: string) => <Badge key={c} variant="secondary">{titleCase(c)}</Badge>)}</div></div><div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Objective</div><div className="text-sm">{rec.objective}</div></div><div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Recency window</div><div className="text-sm">{rec.recencyWindow ?? '—'}</div></div><div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Suggested exclusions</div><div className="text-sm">{rec.suggestedExclusions.length ? rec.suggestedExclusions.map(titleCase).join(', ') : '—'}</div></div><div><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Creative angle</div><div className="text-sm italic">{rec.creativeAngle}</div></div></CardContent></Card>) : <div className="text-sm text-muted-foreground">No recommendation for custom audiences yet.</div>}</TabsContent>
      <TabsContent value="members"><MemberSample audienceId={id} /></TabsContent>
    </Tabs>
    <Card className="mt-4"><CardHeader><CardTitle>Activation funnel (last sync)</CardTitle><CardDescription>Why the eligible number differs from the member count.</CardDescription></CardHeader><CardContent><FunnelFromPreview audienceId={id} /></CardContent></Card>
  </div>);
}

function MemberSample({ audienceId }: { audienceId: string }) {
  const { data, loading } = useApi<{ data: any[] }>(`/api/v1/audiences/${audienceId}/members?limit=25`);
  if (loading || !data) return <LoadingRows />;
  return (<Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Customer</TableHead><TableHead>Identifiers (masked)</TableHead><TableHead>Lifecycle</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">LTV</TableHead><TableHead>Consent</TableHead><TableHead>Entered</TableHead></TableRow></TableHeader><TableBody>
    {data.data.map((c) => <TableRow key={c.id}><TableCell className="pl-5"><Link href={`/customers/${c.id}`} className="hover:underline">{c.external_customer_id ?? `#${c.id}`}</Link>{c.is_primary && <Badge variant="info" className="ml-1">primary</Badge>}</TableCell><TableCell className="font-mono text-[11px] text-muted-foreground">{c.email_hash ?? ''} {c.phone_hash ?? ''}</TableCell><TableCell><Badge variant="outline">{titleCase(c.lifecycle_state)}</Badge></TableCell><TableCell className="num text-right">{c.order_count}</TableCell><TableCell className="num text-right">{fmtMoney(c.lifetime_value)}</TableCell><TableCell><StatusBadge status={c.consent_status} />{c.suppressed && <Badge variant="destructive" className="ml-1">suppressed</Badge>}</TableCell><TableCell className="text-xs text-muted-foreground">{fmtDate(c.entered_at)}</TableCell></TableRow>)}
  </TableBody></Table></CardContent></Card>);
}
function FunnelFromPreview({ audienceId }: { audienceId: string }) {
  const [data, setData] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setErr(null); try { setData(await apiFetch(`/api/v1/audiences/${audienceId}/preview`, { method: 'POST', json: {} })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  if (!data) return <div className="flex items-center gap-3"><Button size="sm" variant="outline" onClick={run} disabled={busy}>{busy ? 'Computing…' : 'Compute funnel'}</Button><span className="text-xs text-muted-foreground">Runs the rule + default compliance policy (bounded by a statement timeout; large audiences are sampled).</span><ErrorBox message={err} /></div>;
  return (<div className="grid gap-6 lg:grid-cols-2"><Funnel steps={[{ label: 'Rule matches', value: data.total }, { label: 'After exclusions', value: data.total - data.excludedByAudience }, { label: 'After suppression', value: data.total - data.excludedByAudience - data.suppressed - data.deleted }, { label: 'Consent OK', value: data.eligible + data.noIdentifier + data.invalidIdentifier }, { label: 'Identifiable', value: data.eligible }, { label: 'Estimated activation', value: data.estimatedActivation }]} />
    <div className="grid grid-cols-2 gap-2 text-xs">{[['Excluded by audiences', data.excludedByAudience], ['Suppressed', data.suppressed], ['Deleted', data.deleted], ['Consent denied', data.consentDenied], ['Consent unknown', data.consentUnknown], ['Consent expired', data.consentExpired], ['Missing consent flags', data.missingFlag], ['Blocked country', data.blockedCountry], ['No identifier', data.noIdentifier], ['Invalid identifier', data.invalidIdentifier], ['Duplicates', data.duplicates], ['Holdout (control)', data.holdout]].map(([l, v]) => <div key={String(l)} className="flex justify-between rounded-md border px-2 py-1.5"><span className="text-muted-foreground">{String(l)}</span><span className="num font-medium">{fmtNum(Number(v))}</span></div>)}{data.estimated && <div className="col-span-2 text-[11px] text-warning">≈ sampled estimate (statement timeout reached)</div>}</div></div>);
}
