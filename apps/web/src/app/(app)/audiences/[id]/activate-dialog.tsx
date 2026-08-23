'use client';
import { useEffect, useState } from 'react';
import { Rocket } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtNum, titleCase } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DestinationIcon, Funnel, ErrorBox } from '@/components/shared/page';
import { Badge } from '@/components/ui/badge';

/** Activation confirmation: pick destination accounts → DRY RUN (funnel + payload estimate, nothing sent) → ACTIVATE. */
export function ActivateDialog({ audienceId, audienceName, onDone }: { audienceId: string; audienceName: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const dests = useApi<{ data: any[] }>(open ? '/api/v1/destinations' : null);
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; type: string; destination: string }>>([]);
  const [selected, setSelected] = useState<string[]>([]); const [syncMode, setSyncMode] = useState<'INCREMENTAL' | 'FULL_REFRESH'>('INCREMENTAL'); const [schedule, setSchedule] = useState<string>('');
  const [dry, setDry] = useState<any>(null); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { (async () => {
    if (!dests.data) return; const out: typeof accounts = [];
    for (const d of dests.data.data.filter((x) => x.status === 'CONNECTED')) { const det = await apiFetch<{ accounts: any[] }>(`/api/v1/destinations/${d.id}`); for (const a of det.accounts) out.push({ id: a.id, name: a.name, type: d.type, destination: d.name }); }
    setAccounts(out);
  })(); }, [dests.data]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const dryRun = async () => { setBusy('dry'); setErr(null); try { setDry(await apiFetch(`/api/v1/audiences/${audienceId}/activate`, { method: 'POST', json: { destinationAccountIds: selected, syncMode, syncSchedule: schedule || null, dryRun: true } })); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };
  const activate = async () => { setBusy('go'); setErr(null); try { await apiFetch(`/api/v1/audiences/${audienceId}/activate`, { method: 'POST', json: { destinationAccountIds: selected, syncMode, syncSchedule: schedule || null } }); setOpen(false); setDry(null); setSelected([]); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };
  return (<Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setDry(null); setErr(null); } }}>
    <DialogTrigger asChild><Button size="sm"><Rocket className="h-4 w-4" />Activate</Button></DialogTrigger>
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>Activate “{audienceName}”</DialogTitle><DialogDescription>Choose destinations, run a dry run (no data is sent), then confirm. Consent, suppression and exclusions are applied automatically on every sync.</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <div><div className="mb-1.5 text-xs font-medium">Destination accounts</div>
          {accounts.length ? <div className="grid gap-2 sm:grid-cols-2">{accounts.map((a) => <label key={a.id} className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm ${selected.includes(a.id) ? 'border-primary bg-accent' : ''}`}><input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} /><DestinationIcon type={a.type} /><span className="min-w-0"><div className="truncate font-medium">{a.destination}</div><div className="truncate text-[11px] text-muted-foreground">{a.name}</div></span></label>)}</div> : <div className="text-xs text-muted-foreground">{dests.loading ? 'Loading…' : 'No connected destinations — connect Meta or Google on the Destinations page.'}</div>}
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs"><label className="space-y-1"><span className="font-medium">Sync mode</span><select className="h-9 w-full rounded-md border bg-background px-2" value={syncMode} onChange={(e) => setSyncMode(e.target.value as never)}><option value="INCREMENTAL">Incremental (delta adds/removes)</option><option value="FULL_REFRESH">Full refresh each sync</option></select></label>
          <label className="space-y-1"><span className="font-medium">Sync schedule</span><select className="h-9 w-full rounded-md border bg-background px-2" value={schedule} onChange={(e) => setSchedule(e.target.value)}><option value="">Same as audience evaluation</option>{['REALTIME', 'HOURLY', 'EVERY_6_HOURS', 'DAILY', 'MANUAL'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select></label></div>
        {dry && <div className="space-y-3 rounded-md border bg-muted/40 p-3">{dry.reports.map((r: any) => (<div key={r.destinationAccountId}><div className="mb-2 flex items-center gap-2 text-xs font-medium"><DestinationIcon type={r.destinationType} />{r.accountName}<Badge variant="warning">DRY RUN — nothing sent</Badge></div>
          <Funnel steps={[{ label: 'Source members', value: r.funnel.total }, { label: 'After exclusions', value: r.funnel.total - r.funnel.excludedByAudience }, { label: 'Consent-approved', value: r.funnel.eligible + r.funnel.noIdentifier + r.funnel.invalidIdentifier }, { label: 'Identifiable', value: r.funnel.eligible }, { label: 'Estimated payload', value: r.estimatedPayload.records }]} />
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground"><span>Suppressed: <b>{fmtNum(r.funnel.suppressed)}</b></span><span>Consent denied/unknown: <b>{fmtNum(r.funnel.consentDenied + r.funnel.consentUnknown + r.funnel.consentExpired)}</b></span><span>Missing/invalid identifiers: <b>{fmtNum(r.funnel.noIdentifier + r.funnel.invalidIdentifier)}</b></span><span>Duplicates: <b>{fmtNum(r.funnel.duplicates)}</b></span><span>Holdout: <b>{fmtNum(r.funnel.holdout)}</b></span><span>Batches: <b>{r.estimatedPayload.batches}</b> × {fmtNum(r.estimatedPayload.maxBatchSize)} · profiles {Object.values(r.estimatedPayload.identifierProfiles).join(', ')}</span></div></div>))}</div>}
        <ErrorBox message={err} />
      </div>
      <DialogFooter><Button variant="outline" disabled={!selected.length || !!busy} onClick={dryRun}>{busy === 'dry' ? 'Running…' : 'Dry run'}</Button><Button disabled={!selected.length || !!busy || !dry} onClick={activate}>{busy === 'go' ? 'Activating…' : 'ACTIVATE AUDIENCE'}</Button></DialogFooter>
      {!dry && selected.length > 0 && <div className="text-[11px] text-muted-foreground">Run the dry run first — activation is enabled after you have reviewed the funnel.</div>}
    </DialogContent>
  </Dialog>);
}
