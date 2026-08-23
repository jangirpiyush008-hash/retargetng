'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/api-client';
import { fmtDate, fmtNum, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, Stat, StatusBadge, DestinationIcon, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';

export default function SyncJobsPage() {
  const [status, setStatus] = useState(''); const [cursor, setCursor] = useState<string | undefined>();
  const { data, error, loading } = useApi<{ data: any[]; nextCursor: string | null; counts7d: Record<string, number>; queue: any[] }>(`/api/v1/sync-jobs?limit=40${status ? `&status=${status}` : ''}${cursor ? `&cursor=${cursor}` : ''}`, { refreshMs: 15_000 });
  const c = data?.counts7d ?? {};
  return (<div>
    <PageHeader title="Sync Jobs" description="Every synchronization is a checkpointed job: eligibility funnel → delta (ADD/REMOVE) → batches with retries. Failed batches can be retried without resending the rest." />
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
      <Stat label="Success (7d)" value={fmtNum((c.SUCCESS ?? 0))} tone="success" /><Stat label="With warnings (7d)" value={fmtNum(c.SUCCESS_WITH_WARNINGS ?? 0)} tone="warning" /><Stat label="Failed (7d)" value={fmtNum(c.FAILED ?? 0)} tone={c.FAILED ? 'danger' : 'default'} /><Stat label="Running / queued" value={fmtNum((c.RUNNING ?? 0) + (c.QUEUED ?? 0))} /><Stat label="Queue depth" value={fmtNum(data?.queue.reduce((s, q) => s + q.pending, 0) ?? 0)} hint={data?.queue.map((q) => `${q.queue.split('.').pop()} ${q.pending}`).join(' · ')} />
    </div>
    <div className="mb-3 flex items-center gap-2"><select className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setCursor(undefined); }}><option value="">All statuses</option>{['QUEUED', 'RUNNING', 'SUCCESS', 'SUCCESS_WITH_WARNINGS', 'FAILED', 'PAUSED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select></div>
    <ErrorBox message={error} />
    <Card><CardContent className="p-0">{loading && !data ? <div className="p-4"><LoadingRows /></div> : (<Table><TableHeader><TableRow><TableHead className="pl-5">Job</TableHead><TableHead>Audience</TableHead><TableHead>Destination</TableHead><TableHead>Trigger / mode</TableHead><TableHead className="text-right">Evaluated</TableHead><TableHead className="text-right">Eligible</TableHead><TableHead className="text-right">Added</TableHead><TableHead className="text-right">Removed</TableHead><TableHead className="text-right">Skipped</TableHead><TableHead className="text-right">Failed</TableHead><TableHead>Batches</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead></TableRow></TableHeader><TableBody>
      {data?.data.map((j) => <TableRow key={j.id}><TableCell className="pl-5 font-mono text-[11px]"><Link href={`/sync-jobs/${j.id}`} className="hover:underline">#{j.id.slice(0, 8)}</Link></TableCell><TableCell><Link href={`/audiences/${j.audience_id}`} className="hover:underline">{j.audience_name}</Link></TableCell><TableCell><span className="flex items-center gap-1.5 text-xs"><DestinationIcon type={j.destination_type} />{j.account_name}</span></TableCell><TableCell className="text-xs">{titleCase(j.trigger)} · {j.mode}</TableCell><TableCell className="num text-right">{fmtNum(j.records_evaluated)}</TableCell><TableCell className="num text-right">{fmtNum(j.eligible_count)}</TableCell><TableCell className="num text-right text-success">+{fmtNum(j.added)}</TableCell><TableCell className="num text-right text-destructive">−{fmtNum(j.removed)}</TableCell><TableCell className="num text-right">{fmtNum(j.skipped)}</TableCell><TableCell className="num text-right">{fmtNum(j.failed)}</TableCell><TableCell className="num text-xs">{j.batches_done}/{j.batches_total}</TableCell><TableCell><StatusBadge status={j.status} /></TableCell><TableCell className="text-xs text-muted-foreground" title={fmtDate(j.started_at)}>{timeAgo(j.started_at ?? j.created_at)}</TableCell></TableRow>)}
      {data && !data.data.length && <TableRow><TableCell colSpan={13} className="py-10 text-center text-sm text-muted-foreground">No sync jobs.</TableCell></TableRow>}</TableBody></Table>)}</CardContent></Card>
    {data?.nextCursor && <div className="mt-3 text-center"><Button variant="outline" size="sm" onClick={() => setCursor(data.nextCursor!)}>Load older</Button></div>}
  </div>);
}
