'use client';
import { useState } from 'react';
import { ShieldBan } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtDate, fmtNum, titleCase } from '@/lib/utils';
import { PageHeader, Stat, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const REASONS = ['UNSUBSCRIBE', 'PRIVACY_REQUEST', 'CUSTOMER_DELETION', 'ADVERTISING_OPT_OUT', 'LEGAL_RESTRICTION', 'INTERNAL_BLACKLIST', 'FRAUD', 'CUSTOMER_COMPLAINT', 'OTHER'];
export default function SuppressionPage() {
  const { data, error, loading, reload } = useApi<{ data: any[]; nextCursor: string | null; stats: { suppressedCustomers: number; byReason: Record<string, number> } }>('/api/v1/suppression?limit=50');
  const [identifier, setIdentifier] = useState(''); const [reason, setReason] = useState('UNSUBSCRIBE'); const [note, setNote] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const add = async () => { setBusy(true); setMsg(null); try {
    const isEmail = identifier.includes('@'); const isNum = /^\d+$/.test(identifier.trim());
    const r = await apiFetch<{ customersSuppressed: number }>('/api/v1/suppression', { method: 'POST', json: { ...(isEmail ? { email: identifier.trim() } : isNum ? { customerId: Number(identifier) } : { phone: identifier.trim() }), reason, note: note || undefined } });
    setMsg(`Suppressed ${r.customersSuppressed} customer(s)${r.customersSuppressed === 0 ? ' — stored as a hash tombstone for future imports' : ''}. Removal from destinations has been queued.`); setIdentifier(''); setNote(''); reload();
  } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  return (<div>
    <PageHeader title="Suppression" description="The global suppression list overrides every audience rule. Suppressed customers are removed from all destination audiences on the next sync (queued immediately) and never re-activated, even if re-imported." />
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Suppressed customers" value={fmtNum(data?.stats.suppressedCustomers)} tone="danger" />{Object.entries(data?.stats.byReason ?? {}).slice(0, 3).map(([k, v]) => <Stat key={k} label={titleCase(k)} value={fmtNum(v)} />)}</div>
        <ErrorBox message={error} />
        <Card><CardContent className="p-0">{loading ? <div className="p-4"><LoadingRows /></div> : (<Table><TableHeader><TableRow><TableHead className="pl-5">Customer</TableHead><TableHead>Identifier (masked)</TableHead><TableHead>Reason</TableHead><TableHead>Source</TableHead><TableHead>Created</TableHead><TableHead>State</TableHead><TableHead /></TableRow></TableHeader><TableBody>
          {data?.data.map((s) => <TableRow key={s.id}><TableCell className="pl-5">{s.customer_id ? <a href={`/customers/${s.customer_id}`} className="hover:underline">#{s.customer_id}</a> : <span className="text-muted-foreground">tombstone</span>}</TableCell><TableCell className="font-mono text-[11px]">{s.identifier_kind} {s.identifier_hash}</TableCell><TableCell><Badge variant="destructive">{titleCase(s.reason)}</Badge></TableCell><TableCell className="text-xs">{s.source ?? '—'}{s.note ? ` · ${s.note}` : ''}</TableCell><TableCell className="text-xs text-muted-foreground">{fmtDate(s.created_at)}</TableCell><TableCell>{s.revoked_at ? <Badge variant="muted">revoked</Badge> : s.expires_at ? <Badge variant="warning">expires {fmtDate(s.expires_at)}</Badge> : <Badge variant="success">active</Badge>}</TableCell><TableCell className="text-right">{!s.revoked_at && <Button size="xs" variant="ghost" onClick={async () => { if (confirm('Revoke this suppression?')) { await apiFetch(`/api/v1/suppression/${s.id}`, { method: 'DELETE' }); reload(); } }}>Revoke</Button>}</TableCell></TableRow>)}
          {data && !data.data.length && <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No suppression records.</TableCell></TableRow>}</TableBody></Table>)}</CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldBan className="h-4 w-4" />Add suppression</CardTitle><CardDescription>Email/phone is hashed server-side; the raw value is not stored.</CardDescription></CardHeader><CardContent className="space-y-3">
        <div className="space-y-1"><Label>Email, phone or customer id</Label><Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="jane@example.com · +91… · 12345" /></div>
        <div className="space-y-1"><Label>Reason</Label><select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</select></div>
        <div className="space-y-1"><Label>Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <Button className="w-full" disabled={!identifier || busy} onClick={add}>{busy ? 'Suppressing…' : 'Suppress'}</Button>
        {msg && <div className="rounded-md bg-muted px-3 py-2 text-xs">{msg}</div>}
        <div className="border-t pt-3 text-[11px] text-muted-foreground">Sources that suppress automatically: CONSENT_REVOKED (advertising), CUSTOMER_DELETED, privacy requests, fraud/complaint flags from your systems via the events API.</div>
      </CardContent></Card>
    </div>
  </div>);
}
