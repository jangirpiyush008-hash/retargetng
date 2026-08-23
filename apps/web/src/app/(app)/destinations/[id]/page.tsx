'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtDate, fmtNum, fmtPct, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, StatusBadge, DestinationIcon, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/misc';

export default function DestinationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const router = useRouter();
  const { data, error, loading, reload } = useApi<any>(`/api/v1/destinations/${id}`);
  const [msg, setMsg] = useState<string | null>(null); const [cred, setCred] = useState(''); const [busy, setBusy] = useState(false);
  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(true); try { const r = await fn(); setMsg(`${label}: ${typeof r === 'object' && r && 'message' in (r as object) ? (r as { message: string }).message : 'ok'}`); reload(); } catch (e) { setMsg(`${label} failed: ${(e as Error).message}`); } finally { setBusy(false); } };
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows />;
  return (<div>
    <PageHeader eyebrow={<Link href="/destinations" className="hover:underline">Destinations</Link>} title={<span className="flex items-center gap-3"><DestinationIcon type={data.type} className="h-8 w-8 text-sm" />{data.name}<StatusBadge status={data.status} /><Badge variant="muted">{data.mode}</Badge></span>} description={`${titleCase(data.type)} · API ${data.config?.api_version ?? 'default'} · credential ${data.hasCredential ? 'stored in secret store' : 'none'}`}
      actions={<><Button variant="outline" size="sm" disabled={busy} onClick={() => act('Test connection', () => apiFetch(`/api/v1/destinations/${id}/test`, { method: 'POST' }))}>Test connection</Button>
        {data.status === 'DISCONNECTED' ? null : <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (confirm('Disconnect? Credentials are deleted and syncs are paused.')) void act('Disconnect', () => apiFetch(`/api/v1/destinations/${id}`, { method: 'DELETE' })); }}>Disconnect</Button>}
        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => { if (confirm('Remove this destination entirely? Only possible when no audiences are active on it.')) void act('Remove', async () => { await apiFetch(`/api/v1/destinations/${id}?hard=true`, { method: 'DELETE' }); router.push('/destinations'); }); }}>Remove</Button></>} />
    {msg && <div className="mb-3 rounded-md border bg-muted px-3 py-2 text-xs">{msg}</div>}
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2"><CardHeader><CardTitle>Ad accounts</CardTitle><CardDescription>Discovered by the connector. Validate checks permissions / terms for Custom Audiences or Customer Match.</CardDescription></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Account</TableHead><TableHead>External id</TableHead><TableHead>Currency</TableHead><TableHead>Validation</TableHead><TableHead /></TableRow></TableHeader><TableBody>
        {data.accounts.map((a: any) => <TableRow key={a.id}><TableCell className="pl-5 font-medium">{a.name} {a.is_default && <Badge variant="info">default</Badge>}</TableCell><TableCell className="font-mono text-xs">{a.external_account_id}</TableCell><TableCell className="text-xs">{a.currency ?? '—'} · {a.timezone ?? '—'}</TableCell><TableCell className="text-xs">{a.metadata?.validation ? <span className={a.metadata.validation.ok ? 'text-success' : 'text-destructive'}>{a.metadata.validation.message}</span> : <span className="text-muted-foreground">not validated</span>}</TableCell>
          <TableCell className="space-x-1 text-right"><Button size="xs" variant="outline" disabled={busy} onClick={() => act('Validate', () => apiFetch(`/api/v1/destinations/${id}/accounts`, { method: 'POST', json: { accountId: a.id, action: 'validate' } }))}>Validate</Button>{!a.is_default && <Button size="xs" variant="ghost" disabled={busy} onClick={() => act('Default', () => apiFetch(`/api/v1/destinations/${id}/accounts`, { method: 'POST', json: { accountId: a.id, action: 'set_default' } }))}>Make default</Button>}</TableCell></TableRow>)}
        {!data.accounts.length && <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">No accounts discovered — test the connection.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
      <Card><CardHeader><CardTitle>Connection</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">Status</span><StatusBadge status={data.status} /></div><div className="flex justify-between"><span className="text-muted-foreground">Last tested</span><span>{fmtDate(data.last_tested_at)}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Last sync</span><span>{timeAgo(data.last_sync_at)}</span></div>
        <div className="rounded bg-muted p-2">{data.connection_status?.message ?? '—'}</div>
        <div className="border-t pt-2"><div className="mb-1 font-medium">Reconnect with a new credential</div><Textarea rows={3} value={cred} onChange={(e) => setCred(e.target.value)} placeholder={data.type === 'GOOGLE_ADS' ? '{"client_id":"…","client_secret":"…","refresh_token":"…"}' : 'access token'} /><Button size="sm" className="mt-2" disabled={!cred || busy} onClick={() => act('Reconnect', async () => { const r = await apiFetch(`/api/v1/destinations/${id}/reconnect`, { method: 'POST', json: { credential: cred } }); setCred(''); return r; })}>Reconnect</Button></div>
        <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-[10px]">{JSON.stringify(data.config, null, 2)}</pre>
      </CardContent></Card>
    </div>
    <Card className="mt-4"><CardHeader><CardTitle>Audiences on this destination</CardTitle></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Audience</TableHead><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead>Remote id</TableHead><TableHead className="text-right">Submitted</TableHead><TableHead className="text-right">Matched</TableHead><TableHead className="text-right">Match rate</TableHead><TableHead>Last / next sync</TableHead></TableRow></TableHeader><TableBody>
      {data.audiences.map((a: any) => <TableRow key={a.id}><TableCell className="pl-5"><Link href={`/audiences/${a.audience_id}`} className="hover:underline">{a.audience_name}</Link></TableCell><TableCell className="text-xs">{a.account_name}</TableCell><TableCell><StatusBadge status={a.status} />{a.last_error && <div className="max-w-[200px] truncate text-[10px] text-destructive">{a.last_error}</div>}</TableCell><TableCell className="font-mono text-[11px]">{a.external_audience_id ?? '—'}</TableCell><TableCell className="num text-right">{fmtNum(a.submitted_count)}</TableCell><TableCell className="num text-right">{fmtNum(a.matched_count)}</TableCell><TableCell className="num text-right">{fmtPct(a.match_rate)}</TableCell><TableCell className="text-xs text-muted-foreground">{timeAgo(a.last_synced_at)} / {timeAgo(a.next_sync_at)}</TableCell></TableRow>)}
      {!data.audiences.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">No audiences activated here yet.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
  </div>);
}
