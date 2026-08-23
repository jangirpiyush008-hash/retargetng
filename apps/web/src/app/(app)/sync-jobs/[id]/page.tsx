'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtDate, fmtNum, titleCase } from '@/lib/utils';
import { PageHeader, Stat, StatusBadge, DestinationIcon, Funnel, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function SyncJobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, loading, reload } = useApi<{ job: any; batches: any[] }>(`/api/v1/sync-jobs/${id}`, { refreshMs: 10_000 });
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows />;
  const j = data.job;
  const dur = j.started_at && j.finished_at ? Math.round((new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000) : null;
  return (<div>
    <PageHeader eyebrow={<Link href="/sync-jobs" className="hover:underline">Sync jobs</Link>} title={<span className="flex items-center gap-3">SYNC #{j.id.slice(0, 8)} <StatusBadge status={j.status} /></span>} description={<span className="flex items-center gap-2"><Link href={`/audiences/${j.audience_id}`} className="font-medium hover:underline">{j.audience_name}</Link> → <DestinationIcon type={j.destination_type} /> {j.destination_name} · {j.account_name} ({j.external_account_id}) · {titleCase(j.trigger)} · {j.mode}</span>}
      actions={<>{(j.status === 'SUCCESS_WITH_WARNINGS' || j.status === 'FAILED' || j.status === 'PAUSED') && <Button size="sm" variant="outline" onClick={async () => { try { await apiFetch(`/api/v1/sync-jobs/${id}/retry`, { method: 'POST' }); setMsg('Retry enqueued'); reload(); } catch (e) { setMsg((e as Error).message); } }}>Retry failed batches</Button>}{(j.status === 'RUNNING' || j.status === 'QUEUED') && <Button size="sm" variant="outline" onClick={async () => { await apiFetch(`/api/v1/sync-jobs/${id}/cancel`, { method: 'POST' }); reload(); }}>Cancel</Button>}</>} />
    {msg && <div className="mb-3 rounded-md border bg-muted px-3 py-2 text-xs">{msg}</div>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      <Stat label="Started" value={<span className="text-sm">{fmtDate(j.started_at)}</span>} /><Stat label="Completed" value={<span className="text-sm">{fmtDate(j.finished_at)}</span>} hint={dur != null ? `${dur}s` : undefined} /><Stat label="Records evaluated" value={fmtNum(j.records_evaluated)} /><Stat label="Eligible" value={fmtNum(j.eligible_count)} tone="success" />
      <Stat label="Added" value={<span className="text-success">+{fmtNum(j.added)}</span>} /><Stat label="Removed" value={<span className="text-destructive">−{fmtNum(j.removed)}</span>} /><Stat label="Skipped" value={fmtNum(j.skipped)} hint="no usable identifier" /><Stat label="Failed" value={fmtNum(j.failed)} tone={Number(j.failed) ? 'danger' : 'default'} />
    </div>
    {j.error && <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{j.error}</div>}
    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Card><CardHeader><CardTitle>Eligibility funnel</CardTitle><CardDescription>Computed at job start from the database</CardDescription></CardHeader><CardContent>
        <Funnel steps={[{ label: 'Source members', value: Number(j.source_count) }, { label: 'After exclusions', value: Number(j.source_count) - Number(j.excluded_by_audience) }, { label: 'Not suppressed', value: Number(j.source_count) - Number(j.excluded_by_audience) - Number(j.suppressed_count) }, { label: 'Consent OK', value: Number(j.eligible_count) + Number(j.no_identifier_count) + Number(j.holdout_count) }, { label: 'Eligible', value: Number(j.eligible_count) }]} />
        <div className="mt-3 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground"><span>Excluded by audience: <b>{fmtNum(j.excluded_by_audience)}</b></span><span>Suppressed/deleted: <b>{fmtNum(j.suppressed_count)}</b></span><span>Consent denied: <b>{fmtNum(j.consent_denied_count)}</b></span><span>Consent unknown: <b>{fmtNum(j.consent_unknown_count)}</b></span><span>Consent expired: <b>{fmtNum(j.consent_expired_count)}</b></span><span>No identifier: <b>{fmtNum(j.no_identifier_count)}</b></span><span>Holdout: <b>{fmtNum(j.holdout_count)}</b></span></div>
        {j.checkpoint && <pre className="mt-3 rounded bg-muted p-2 font-mono text-[10px]">{JSON.stringify(j.checkpoint)}</pre>}
      </CardContent></Card>
      <Card className="lg:col-span-2"><CardHeader><CardTitle>Batches ({j.batches_done}/{j.batches_total})</CardTitle><CardDescription>Each batch is one destination request (≤ 10k identifiers). Platform responses are summarized — never stored with samples.</CardDescription></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Seq</TableHead><TableHead>Op</TableHead><TableHead className="text-right">Members</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Attempts</TableHead><TableHead>Response</TableHead><TableHead>Error</TableHead><TableHead>Finished</TableHead></TableRow></TableHeader><TableBody>
        {data.batches.map((b) => <TableRow key={b.seq}><TableCell className="pl-5 num">{b.seq}</TableCell><TableCell><span className={b.operation === 'ADD' ? 'text-success' : 'text-destructive'}>{b.operation}</span></TableCell><TableCell className="num text-right">{fmtNum(b.member_count)}</TableCell><TableCell><StatusBadge status={b.status} /></TableCell><TableCell className="num text-right">{b.attempts}</TableCell><TableCell className="font-mono text-[10px] text-muted-foreground">{b.response_summary ? JSON.stringify(b.response_summary).slice(0, 80) : '—'}</TableCell><TableCell className="text-[11px] text-destructive">{b.error_code ?? ''} {b.error_message ?? ''}</TableCell><TableCell className="text-xs text-muted-foreground">{fmtDate(b.finished_at)}</TableCell></TableRow>)}
        {!data.batches.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No batches — nothing to add or remove (delta was empty{j.mode === 'DRY_RUN' ? ' / dry run' : ''}).</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    </div>
  </div>);
}
