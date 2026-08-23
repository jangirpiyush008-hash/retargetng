'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Plug, Plus } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtNum, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, StatusBadge, DestinationIcon, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/misc';

export default function DestinationsPage() {
  const { data, error, loading, reload } = useApi<{ data: any[]; catalog: any[]; mode: string }>('/api/v1/destinations', { refreshMs: 30_000 });
  return (<div>
    <PageHeader title="Destinations" description="Advertising platforms receive only hashed identifiers of eligible customers. Credentials are stored in the secret store — never in the database or the browser." actions={<ConnectDialog catalog={data?.catalog ?? []} mode={data?.mode ?? 'mock'} onDone={reload} />} />
    {data?.mode === 'mock' && <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">DESTINATION_MODE=mock — Meta and Google resolve to in-memory simulators. No customer data leaves this system. Set DESTINATION_MODE=live and provide credentials to use real accounts.</div>}
    <ErrorBox message={error} />
    {loading ? <LoadingRows /> : (<div className="grid gap-4 md:grid-cols-2">
      {data?.data.map((d) => (<Card key={d.id}><CardHeader className="flex-row items-start justify-between"><div className="flex items-center gap-3"><DestinationIcon type={d.type} className="h-9 w-9 text-sm" /><div><CardTitle className="text-base">{d.name}</CardTitle><CardDescription>{titleCase(d.type)} · {d.mode === 'mock' ? 'mock' : 'live'} · connected {timeAgo(d.created_at)}</CardDescription></div></div><StatusBadge status={d.status} /></CardHeader>
        <CardContent><div className="grid grid-cols-3 gap-3 text-xs"><div><div className="text-muted-foreground">Accounts</div><div className="num text-base font-semibold">{fmtNum(d.account_count)}</div></div><div><div className="text-muted-foreground">Active audiences</div><div className="num text-base font-semibold">{fmtNum(d.audience_count)}</div></div><div><div className="text-muted-foreground">Failed audiences</div><div className={`num text-base font-semibold ${Number(d.failed_audiences) ? 'text-destructive' : ''}`}>{fmtNum(d.failed_audiences)}</div></div></div>
          <div className="mt-3 text-xs text-muted-foreground">Last sync {timeAgo(d.last_sync_at)} · last test {timeAgo(d.last_tested_at)}{d.connection_status?.message ? ` · ${d.connection_status.message}` : ''}</div>
          {d.last_error && <div className="mt-2 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{d.last_error}</div>}
          <div className="mt-4 flex gap-2"><Button size="sm" variant="outline" asChild><Link href={`/destinations/${d.id}`}>Manage</Link></Button><Button size="sm" variant="ghost" onClick={async () => { await apiFetch(`/api/v1/destinations/${d.id}/test`, { method: 'POST' }); reload(); }}>Test connection</Button></div>
        </CardContent></Card>))}
      {!data?.data.length && <div className="col-span-2 rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground"><Plug className="mx-auto mb-2 h-6 w-6" />No destinations connected yet.</div>}
    </div>)}
  </div>);
}

function ConnectDialog({ catalog, mode, onDone }: { catalog: any[]; mode: string; onDone: () => void }) {
  const [open, setOpen] = useState(false); const [type, setType] = useState('META'); const [name, setName] = useState('Meta Ads'); const [credential, setCredential] = useState(''); const [config, setConfig] = useState('{}'); const [dev, setDev] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [result, setResult] = useState<any>(null);
  const isMock = mode === 'mock' || type.startsWith('MOCK');
  const submit = async () => { setBusy(true); setErr(null); try {
    let cfg: Record<string, unknown> = {}; try { cfg = JSON.parse(config || '{}'); } catch { throw new Error('Config must be valid JSON'); }
    const r = await apiFetch('/api/v1/destinations', { method: 'POST', json: { type, name, config: cfg, credential: credential || undefined, credentials: type === 'GOOGLE_ADS' && dev ? { developer_token: dev } : undefined } });
    setResult(r); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (<Dialog open={open} onOpenChange={(o) => { setOpen(o); setResult(null); setErr(null); }}>
    <DialogTrigger asChild><Button><Plus className="h-4 w-4" />Connect destination</Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>Connect a destination</DialogTitle><DialogDescription>The credential is written to the secret store and the connection is tested immediately.</DialogDescription></DialogHeader>
      {result ? <div className="space-y-2 text-sm"><StatusBadge status={result.ok ? 'CONNECTED' : 'ERROR'} /> {result.message}<div className="text-xs text-muted-foreground">{result.accounts?.length ?? 0} ad account(s) discovered. Open <b>Manage</b> to select accounts.</div></div> : (<div className="space-y-3">
        <div className="space-y-1"><Label>Platform</Label><select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => { setType(e.target.value); setName(catalog.find((c) => c.type === e.target.value)?.name ?? e.target.value); }}>{catalog.map((c) => <option key={c.type} value={c.type}>{c.name}{c.mode === 'mock' ? ' (mock)' : ''}</option>)}</select></div>
        <div className="space-y-1"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        {!isMock && <div className="space-y-1"><Label>{type === 'GOOGLE_ADS' ? 'OAuth credential JSON {client_id, client_secret, refresh_token}' : 'System-user access token'}</Label><Textarea rows={3} value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={type === 'GOOGLE_ADS' ? '{"client_id":"…","client_secret":"…","refresh_token":"…"}' : 'EAAB…'} /></div>}
        {!isMock && type === 'GOOGLE_ADS' && <div className="space-y-1"><Label>Developer token</Label><Input value={dev} onChange={(e) => setDev(e.target.value)} /></div>}
        <div className="space-y-1"><Label>Config (JSON, non-secret)</Label><Textarea rows={2} value={config} onChange={(e) => setConfig(e.target.value)} placeholder={type === 'GOOGLE_ADS' ? '{"login_customer_id":"1234567890"}' : '{"api_version":"v25.0","customer_file_source":"USER_PROVIDED_ONLY"}'} /></div>
        {isMock && <div className="rounded-md bg-muted p-2 text-xs text-muted-foreground">Mock mode: no credential needed. The simulator accepts hashed identifiers and reports approximate counts / match rates.</div>}
        <ErrorBox message={err} /></div>)}
      <DialogFooter>{result ? <Button onClick={() => setOpen(false)}>Done</Button> : <Button onClick={submit} disabled={busy || !name}>{busy ? 'Connecting…' : 'Connect & test'}</Button>}</DialogFooter>
    </DialogContent></Dialog>);
}
