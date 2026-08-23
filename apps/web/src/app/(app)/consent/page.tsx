'use client';
import { useState } from 'react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtCompact, fmtNum, fmtPct, titleCase } from '@/lib/utils';
import { PageHeader, Stat, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/misc';
import { Donut, TrendBars } from '@/components/charts/charts';

export default function ConsentPage() {
  const { data, error, loading, reload } = useApi<any>('/api/v1/consent/overview');
  const [editing, setEditing] = useState<string | null>(null); const [draft, setDraft] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows n={8} />;
  const consent = data.stats.consent as Array<{ consent_status: string; n: number }>; const total = consent.reduce((s, c) => s + c.n, 0); const f = data.flags;
  const save = async (p: any) => { try { const rules = JSON.parse(draft); await apiFetch(`/api/v1/compliance-policies/${p.id}`, { method: 'PATCH', json: { name: p.name, destinationType: p.destination_type, isDefault: p.is_default, rules } }); setEditing(null); setMsg('Policy saved'); reload(); } catch (e) { setMsg((e as Error).message); } };
  return (<div>
    <PageHeader title="Consent & compliance" description="A customer is activated only when the compliance policy for the destination evaluates to eligible. Policies are configurable per organization, destination and region — nothing is hard-coded." />
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {consent.map((c) => <Stat key={c.consent_status} label={`Consent ${titleCase(c.consent_status)}`} value={fmtCompact(c.n)} hint={fmtPct((c.n / Math.max(1, total)) * 100)} tone={c.consent_status === 'GRANTED' ? 'success' : c.consent_status === 'DENIED' ? 'danger' : 'warning'} />)}
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-3">
      <Card><CardHeader><CardTitle>Purpose flags</CardTitle><CardDescription>Derived from consent events</CardDescription></CardHeader><CardContent className="space-y-2 text-sm">{[['Marketing', f.marketing], ['Advertising personalization', f.advertising], ['Data sharing with ad platforms', f.sharing]].map(([l, v]) => <div key={String(l)} className="flex items-center justify-between"><span className="text-muted-foreground">{String(l)}</span><span className="num font-medium">{fmtNum(Number(v))} <span className="text-xs text-muted-foreground">({fmtPct((Number(v) / Math.max(1, Number(f.total))) * 100)})</span></span></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>Consent distribution</CardTitle></CardHeader><CardContent><Donut data={consent.map((c) => ({ name: titleCase(c.consent_status), value: c.n }))} height={180} /></CardContent></Card>
      <Card><CardHeader><CardTitle>Consent events (30d)</CardTitle></CardHeader><CardContent>{data.recent.length ? <TrendBars data={data.recent} series={[{ key: 'granted', label: 'Granted', color: 'hsl(var(--success))' }, { key: 'revoked', label: 'Revoked', color: 'hsl(var(--destructive))' }]} height={180} /> : <div className="text-xs text-muted-foreground">No recent events</div>}</CardContent></Card>
    </div>
    <Card className="mt-4"><CardHeader><CardTitle>Compliance policies</CardTitle><CardDescription>Rules: allowed consent statuses, required flags, consent max age, blocked countries, per-region overrides, identifier requirements, ad-fatigue limits. Compiled to SQL for the eligibility step of every sync.</CardDescription></CardHeader><CardContent className="space-y-3">
      {msg && <div className="rounded-md bg-muted px-3 py-2 text-xs">{msg}</div>}
      {(data.policies as any[]).map((p) => <div key={p.id} className="rounded-lg border p-3"><div className="flex items-center justify-between"><div><span className="font-medium">{p.name}</span> <Badge variant="muted">{p.destination_type ?? 'all destinations'}</Badge> {p.is_default && <Badge variant="info">default</Badge>}</div>{editing === p.id ? <div className="flex gap-2"><Button size="xs" onClick={() => save(p)}>Save</Button><Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div> : <Button size="xs" variant="outline" onClick={() => { setEditing(p.id); setDraft(JSON.stringify(p.rules, null, 2)); }}>Edit (ADMIN)</Button>}</div>
        {editing === p.id ? <Textarea className="mt-2 font-mono text-[11px]" rows={14} value={draft} onChange={(e) => setDraft(e.target.value)} /> : <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{JSON.stringify(p.rules, null, 2)}</pre>}</div>)}
    </CardContent></Card>
  </div>);
}
