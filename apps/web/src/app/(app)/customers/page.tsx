'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useApi } from '@/lib/api-client';
import { fmtCompact, fmtMoney, fmtNum, fmtPct, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, StatusBadge, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/misc';
import { Donut } from '@/components/charts/charts';

export default function CustomersPage() {
  const [q, setQ] = useState(''); const [applied, setApplied] = useState(''); const [lifecycle, setLifecycle] = useState('');
  const list = useApi<{ data: any[]; nextCursor: string | null }>(`/api/v1/customers?limit=30${applied ? `&q=${encodeURIComponent(applied)}` : ''}${lifecycle ? `&lifecycle=${lifecycle}` : ''}`);
  const dq = useApi<{ latest: { score: number; checks: Array<{ key: string; label: string; count: number; total: number; severity: string }>; computedAt: string; history: Array<{ computed_at: string; score: number }> } | null; stats: { lifecycle: Array<{ lifecycle_state: string; n: number }>; consent: Array<{ consent_status: string; n: number }>; countries: Array<{ country: string; n: number }> } }>('/api/v1/data-quality');
  const total = dq.data?.stats.lifecycle.reduce((s, l) => s + l.n, 0) ?? 0;
  return (<div>
    <PageHeader title="Customers" description="Identifiers are shown masked (first 8 hex chars of the SHA-256). Search by external id, or by email/phone — the query is hashed server-side and never stored." />
    <Tabs defaultValue="customers">
      <TabsList><TabsTrigger value="customers">Customers</TabsTrigger><TabsTrigger value="quality">Data quality</TabsTrigger><TabsTrigger value="lifecycle">Lifecycle</TabsTrigger></TabsList>
      <TabsContent value="customers">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(q); }}><div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="w-80 pl-8" placeholder="External id, email or phone…" value={q} onChange={(e) => setQ(e.target.value)} /></div><Button type="submit" variant="secondary">Search</Button></form>
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><option value="">All lifecycle states</option>{['PROSPECT', 'CART_ABANDONER', 'PURCHASER', 'REPEAT_PURCHASER', 'VIP', 'INACTIVE_30D', 'INACTIVE_60D', 'LAPSED_90D', 'LAPSED_180D', 'LAPSED_365D'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select>
          {dq.data && <span className="ml-auto text-xs text-muted-foreground">{fmtNum(total)} customers</span>}
        </div>
        <ErrorBox message={list.error} />
        <Card><CardContent className="p-0">{list.loading ? <div className="p-4"><LoadingRows /></div> : (
          <Table><TableHeader><TableRow><TableHead className="pl-5">Customer</TableHead><TableHead>Identifiers</TableHead><TableHead>Lifecycle</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">LTV</TableHead><TableHead>Last order</TableHead><TableHead>Consent</TableHead><TableHead>Flags</TableHead></TableRow></TableHeader>
            <TableBody>{list.data?.data.map((c) => (<TableRow key={c.id}>
              <TableCell className="pl-5"><Link href={`/customers/${c.id}`} className="font-medium hover:underline">{c.external_customer_id ?? `#${c.id}`}</Link><div className="text-[11px] text-muted-foreground">#{c.id} · {c.country ?? '—'}{c.region ? ` · ${c.region}` : ''}</div></TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">{c.email_hash && <div>✉ {c.email_hash}</div>}{c.phone_hash && <div>☎ {c.phone_hash}</div>}</TableCell>
              <TableCell><Badge variant="outline">{titleCase(c.lifecycle_state)}</Badge></TableCell>
              <TableCell className="num text-right">{fmtNum(c.order_count)}</TableCell><TableCell className="num text-right">{fmtMoney(c.lifetime_value)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{timeAgo(c.last_order_at)}</TableCell><TableCell><StatusBadge status={c.consent_status} /></TableCell>
              <TableCell className="space-x-1">{c.suppressed && <Badge variant="destructive">suppressed</Badge>}{c.deleted && <Badge variant="muted">deleted</Badge>}{c.has_open_cart && <Badge variant="warning">open cart</Badge>}</TableCell>
            </TableRow>))}{list.data && !list.data.data.length && <TableRow><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No customers match.</TableCell></TableRow>}</TableBody></Table>)}</CardContent></Card>
      </TabsContent>
      <TabsContent value="quality">
        {dq.data?.latest ? (<div className="grid gap-4 lg:grid-cols-3">
          <Card><CardHeader><CardTitle>Data quality score</CardTitle><CardDescription>Computed {timeAgo(dq.data.latest.computedAt)}</CardDescription></CardHeader><CardContent><div className="num text-5xl font-semibold">{dq.data.latest.score.toFixed(1)}<span className="text-lg text-muted-foreground"> / 100</span></div><Progress value={dq.data.latest.score} className="mt-3" /><Button size="sm" variant="outline" className="mt-4" onClick={async () => { await fetch('/api/v1/data-quality', { method: 'POST' }); dq.reload(); }}>Recompute now</Button></CardContent></Card>
          <Card className="lg:col-span-2"><CardHeader><CardTitle>Checks</CardTitle><CardDescription>Counts only — no PII samples are ever stored or shown.</CardDescription></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Check</TableHead><TableHead className="text-right">Affected</TableHead><TableHead className="text-right">Rate</TableHead><TableHead>Severity</TableHead></TableRow></TableHeader><TableBody>
            {dq.data.latest.checks.map((c) => <TableRow key={c.key}><TableCell className="pl-5">{c.label}</TableCell><TableCell className="num text-right">{fmtNum(c.count)}</TableCell><TableCell className="num text-right">{fmtPct((c.count / Math.max(1, c.total)) * 100, 2)}</TableCell><TableCell><Badge variant={c.severity === 'error' ? 'destructive' : c.severity === 'warn' ? 'warning' : 'muted'}>{c.severity}</Badge></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
        </div>) : <div className="text-sm text-muted-foreground">No snapshot yet. <Button size="sm" variant="outline" onClick={async () => { await fetch('/api/v1/data-quality', { method: 'POST' }); dq.reload(); }}>Compute</Button></div>}
      </TabsContent>
      <TabsContent value="lifecycle">{dq.data && (<div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Lifecycle states</CardTitle><CardDescription>Derived automatically from purchase/cart data and time (PROSPECT → CART_ABANDONER → PURCHASER → REPEAT → VIP; PURCHASER → INACTIVE → LAPSED).</CardDescription></CardHeader><CardContent className="space-y-2">
          {dq.data.stats.lifecycle.map((l) => <div key={l.lifecycle_state} className="grid grid-cols-[160px_1fr_80px] items-center gap-3 text-xs"><span>{titleCase(l.lifecycle_state)}</span><div className="h-4 rounded bg-muted"><div className="h-full rounded bg-primary/70" style={{ width: `${(l.n / Math.max(1, total)) * 100}%` }} /></div><span className="num text-right">{fmtCompact(l.n)}</span></div>)}</CardContent></Card>
        <Card><CardHeader><CardTitle>Top countries</CardTitle></CardHeader><CardContent><Donut data={dq.data.stats.countries.slice(0, 5).map((c) => ({ name: c.country ?? 'Unknown', value: c.n }))} /></CardContent></Card>
      </div>)}</TabsContent>
    </Tabs>
  </div>);
}
