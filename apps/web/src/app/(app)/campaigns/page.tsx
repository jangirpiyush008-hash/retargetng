'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtCompact, fmtMoney, fmtNum, fmtPct, titleCase } from '@/lib/utils';
import { PageHeader, DestinationIcon, StatusBadge, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';

export default function CampaignsPage() {
  const { data, error, loading, reload } = useApi<{ data: any[] }>('/api/v1/campaigns');
  const auds = useApi<{ data: any[] }>('/api/v1/audiences');
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [objective, setObjective] = useState('Conversions'); const [audienceIds, setAudienceIds] = useState<string[]>([]); const [err, setErr] = useState<string | null>(null);
  const create = async () => { try { await apiFetch('/api/v1/campaigns', { method: 'POST', json: { name, objective, audienceIds } }); setOpen(false); setName(''); reload(); } catch (e) { setErr((e as Error).message); } };
  return (<div>
    <PageHeader title="Campaigns" description="Campaigns are linked to audiences so platform-reported metrics (spend, conversions, revenue) roll up per audience. Metrics arrive via connectors or POST /campaigns/:id/metrics." actions={<Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus className="h-4 w-4" />New campaign</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Link a campaign</DialogTitle><DialogDescription>Attach one or more audiences for attribution.</DialogDescription></DialogHeader>
      <div className="space-y-3"><div className="space-y-1"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div><div className="space-y-1"><Label>Objective</Label><Input value={objective} onChange={(e) => setObjective(e.target.value)} /></div><div className="space-y-1"><Label>Audiences</Label><select multiple className="h-32 w-full rounded-md border bg-background px-2 text-sm" value={audienceIds} onChange={(e) => setAudienceIds([...e.target.selectedOptions].map((o) => o.value))}>{auds.data?.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div><ErrorBox message={err} /></div>
      <DialogFooter><Button onClick={create} disabled={!name}>Create</Button></DialogFooter></DialogContent></Dialog>} />
    <ErrorBox message={error} />
    <Card><CardContent className="p-0">{loading ? <div className="p-4"><LoadingRows /></div> : (<Table><TableHeader><TableRow><TableHead className="pl-5">Campaign</TableHead><TableHead>Destination</TableHead><TableHead>Audiences</TableHead><TableHead className="text-right">Impressions</TableHead><TableHead className="text-right">Clicks</TableHead><TableHead className="text-right">CTR</TableHead><TableHead className="text-right">Spend</TableHead><TableHead className="text-right">Conversions</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">ROAS</TableHead><TableHead className="text-right">CPA</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>
      {data?.data.map((c) => <TableRow key={String(c.id)}><TableCell className="pl-5"><div className="font-medium">{c.name}</div><div className="text-[11px] text-muted-foreground">{c.objective} · {c.external_campaign_id ?? 'no external id'} · last 30 days</div></TableCell><TableCell>{c.destination_type ? <span className="flex items-center gap-1.5 text-xs"><DestinationIcon type={String(c.destination_type)} />{c.account_name}</span> : '—'}</TableCell><TableCell className="text-xs">{(c.audiences as string[] | null)?.join(', ') ?? '—'}</TableCell><TableCell className="num text-right">{fmtCompact(Number(c.impressions))}</TableCell><TableCell className="num text-right">{fmtCompact(Number(c.clicks))}</TableCell><TableCell className="num text-right">{fmtPct(c.ctr as number, 2)}</TableCell><TableCell className="num text-right">{fmtMoney(Number(c.spend))}</TableCell><TableCell className="num text-right">{fmtNum(Number(c.conversions))}</TableCell><TableCell className="num text-right">{fmtMoney(Number(c.revenue))}</TableCell><TableCell className="num text-right font-medium">{c.roas ? `${Number(c.roas).toFixed(2)}x` : '—'}</TableCell><TableCell className="num text-right">{c.cpa ? fmtMoney(Number(c.cpa)) : '—'}</TableCell><TableCell><StatusBadge status={String(c.status)} /></TableCell></TableRow>)}
      {data && !data.data.length && <TableRow><TableCell colSpan={12} className="py-10 text-center text-sm text-muted-foreground">No campaigns linked yet.</TableCell></TableRow>}</TableBody></Table>)}</CardContent></Card>
  </div>);
}
