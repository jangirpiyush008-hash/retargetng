'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useApi } from '@/lib/api-client';
import { fmtCompact, fmtNum, fmtPct, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, StatusBadge, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function AudiencesPage() {
  const { data, error, loading } = useApi<{ data: any[] }>('/api/v1/audiences', { refreshMs: 30_000 });
  const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const rows = (data?.data ?? []).filter((a) => (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.slug.toLowerCase().includes(q.toLowerCase())) && (!status || a.status === status));
  return (<div>
    <PageHeader title="Audiences" description="Dynamic, rule-based segments kept in sync automatically. Members = rule matches; eligible = after consent, suppression and exclusions; match rate = platform-reported." actions={<Button asChild><Link href="/audiences/new"><Plus className="h-4 w-4" />New audience</Link></Button>} />
    <div className="mb-3 flex items-center gap-2"><Input className="w-72" placeholder="Filter by name or slug…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['ACTIVE', 'PAUSED', 'DRAFT'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select>
      <span className="ml-auto text-xs text-muted-foreground">{rows.length} audiences</span></div>
    <ErrorBox message={error} />
    <Card><CardContent className="p-0">{loading ? <div className="p-4"><LoadingRows /></div> : (
      <Table><TableHeader><TableRow><TableHead className="pl-5">Audience</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Priority</TableHead><TableHead className="text-right">Members</TableHead><TableHead className="text-right">Eligible</TableHead><TableHead className="text-right">Added / removed today</TableHead><TableHead>Schedule</TableHead><TableHead>Destinations</TableHead><TableHead className="text-right">Match rate</TableHead><TableHead>Last eval</TableHead><TableHead>Last sync</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((a) => (<TableRow key={a.id}>
          <TableCell className="pl-5"><Link href={`/audiences/${a.id}`} className="font-medium hover:underline">{a.name}</Link><div className="text-[11px] text-muted-foreground">{a.slug}{a.template_key ? ` · ${titleCase(a.template_key)}` : ''}{Number(a.holdout_percent) > 0 ? ` · ${a.holdout_percent}% holdout` : ''}</div></TableCell>
          <TableCell><StatusBadge status={a.status} /></TableCell><TableCell className="num text-right">{a.priority}</TableCell>
          <TableCell className="num text-right font-medium">{fmtNum(a.member_count)}</TableCell><TableCell className="num text-right">{fmtNum(a.eligible_count)}</TableCell>
          <TableCell className="num text-right"><span className="text-success">+{fmtCompact(a.added_today)}</span> / <span className="text-destructive">−{fmtCompact(a.removed_today)}</span></TableCell>
          <TableCell className="text-xs">{titleCase(a.evaluation_schedule)}</TableCell>
          <TableCell>{Number(a.destination_count) ? <Badge variant={Number(a.destination_errors) ? 'destructive' : 'success'}>{a.destination_count}{Number(a.destination_errors) ? ` (${a.destination_errors} err)` : ''}</Badge> : <span className="text-xs text-muted-foreground">not activated</span>}</TableCell>
          <TableCell className="num text-right">{fmtPct(a.match_rate)}</TableCell>
          <TableCell className="text-xs text-muted-foreground">{timeAgo(a.last_evaluated_at)}</TableCell><TableCell className="text-xs text-muted-foreground">{timeAgo(a.last_synced_at)}</TableCell>
        </TableRow>))}{!rows.length && <TableRow><TableCell colSpan={11} className="py-10 text-center text-sm text-muted-foreground">No audiences yet.</TableCell></TableRow>}</TableBody></Table>)}</CardContent></Card>
  </div>);
}
