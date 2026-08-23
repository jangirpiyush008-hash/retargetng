'use client';
import { useState } from 'react';
import { useApi } from '@/lib/api-client';
import { fmtDate, titleCase } from '@/lib/utils';
import { PageHeader, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function AuditLogsPage() {
  const [action, setAction] = useState(''); const [cursor, setCursor] = useState<string | undefined>();
  const { data, error, loading } = useApi<{ data: any[]; nextCursor: string | null }>(`/api/v1/audit-logs?limit=60${action ? `&action=${encodeURIComponent(action)}` : ''}${cursor ? `&cursor=${cursor}` : ''}`);
  return (<div>
    <PageHeader title="Audit Logs" description="Who did what, when, from where — with before/after snapshots. Retained per the audit_logs retention policy (default 7 years)." />
    <div className="mb-3 flex gap-2"><Input className="w-72" placeholder="Filter by action (e.g. AUDIENCE_ACTIVATED)" value={action} onChange={(e) => { setAction(e.target.value.toUpperCase()); setCursor(undefined); }} /></div>
    <ErrorBox message={error} />
    <Card><CardContent className="p-0">{loading && !data ? <div className="p-4"><LoadingRows /></div> : (<Table><TableHeader><TableRow><TableHead className="pl-5">When</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead>Before → After</TableHead><TableHead>Where</TableHead></TableRow></TableHeader><TableBody>
      {data?.data.map((l) => <TableRow key={l.id}><TableCell className="pl-5 whitespace-nowrap text-xs">{fmtDate(l.occurred_at)}</TableCell><TableCell className="text-xs"><Badge variant="outline">{l.actor_type}</Badge> {l.actor_label}</TableCell><TableCell><Badge variant="secondary">{l.action}</Badge></TableCell><TableCell className="font-mono text-[11px]">{l.entity_type}{l.entity_id ? `:${String(l.entity_id).slice(0, 8)}` : ''}</TableCell><TableCell className="max-w-[420px] font-mono text-[10px] text-muted-foreground"><div className="truncate" title={JSON.stringify({ before: l.before, after: l.after, metadata: l.metadata })}>{l.before ? JSON.stringify(l.before).slice(0, 80) + ' → ' : ''}{JSON.stringify(l.after ?? l.metadata).slice(0, 120)}</div></TableCell><TableCell className="text-xs text-muted-foreground">{l.ip ?? '—'}</TableCell></TableRow>)}
      {data && !data.data.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No audit entries.</TableCell></TableRow>}</TableBody></Table>)}</CardContent></Card>
    {data?.nextCursor && <div className="mt-3 text-center"><Button variant="outline" size="sm" onClick={() => setCursor(data.nextCursor!)}>Load older</Button></div>}
    <p className="mt-2 text-[11px] text-muted-foreground">{titleCase('tip')}: actions include AUDIENCE_CREATED/UPDATED/ACTIVATED, DESTINATION_CONNECTED/TESTED, SUPPRESSION_ADDED, COMPLIANCE_POLICY_UPDATED, API_KEY_CREATED, USER_LOGIN.</p>
  </div>);
}
