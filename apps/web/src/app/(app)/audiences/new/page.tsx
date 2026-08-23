'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Sparkles, Eye, Save } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtNum, titleCase } from '@/lib/utils';
import { PageHeader, Funnel, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/misc';
import { EntityPicker } from '@/components/shared/entity-picker';

type Cond = { type: 'condition'; field: string; operator: string; value?: unknown; params?: Record<string, unknown>; negate?: boolean };
type Group = { type: 'group'; operator: 'AND' | 'OR'; negate?: boolean; children: Node[] };
type Node = Cond | Group;
interface Field { key: string; label: string; group: string; type: string; enumValues?: string[]; supportsWindow?: boolean; supportsMinCount?: boolean; description: string }

const OP_LABEL: Record<string, string> = { eq: 'equals', neq: 'does not equal', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between', in: 'is any of', not_in: 'is none of', contains: 'contains', starts_with: 'starts with', is_null: 'is empty', is_not_null: 'is set', within_last: 'within last', more_than_ago: 'more than … ago', between_ago: 'between … ago', before: 'before', after: 'after', any: 'any (at least one)', none: 'none' };
const defaultValue = (f: Field, op: string): unknown => {
  if (['is_null', 'is_not_null', 'any', 'none'].includes(op)) return undefined;
  if (f.type === 'boolean') return true; if (f.type === 'number' || f.type === 'custom_number') return op === 'between' ? [0, 1000] : 0;
  if (f.type === 'timestamp') return op === 'between_ago' ? { min: 1, max: 3, unit: 'days' } : op === 'before' || op === 'after' ? new Date().toISOString().slice(0, 10) : { value: 30, unit: 'days' };
  if (f.type === 'enum') return op === 'in' || op === 'not_in' ? [f.enumValues?.[0]] : f.enumValues?.[0];
  if (['product', 'category', 'audience'].includes(f.type)) return [];
  return op === 'in' || op === 'not_in' ? [] : '';
};

export default function AudienceBuilderPage() {
  const router = useRouter();
  const meta = useApi<{ fields: Field[]; operators: Record<string, string[]> }>('/api/v1/audiences/fields');
  const tpl = useApi<{ templates: any[]; standard: any[] }>('/api/v1/audiences/templates');
  const auds = useApi<{ data: any[] }>('/api/v1/audiences');
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [schedule, setSchedule] = useState('HOURLY'); const [priority, setPriority] = useState(100); const [holdout, setHoldout] = useState(0);
  const [excl, setExcl] = useState<string[]>([]); const [root, setRoot] = useState<Group>({ type: 'group', operator: 'AND', children: [] });
  const [mode, setMode] = useState<'builder' | 'template'>('builder'); const [tplKey, setTplKey] = useState(''); const [tplParams, setTplParams] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null); const [activateAfter, setActivateAfter] = useState(true);
  const fields = meta.data?.fields ?? []; const ops = meta.data?.operators ?? {};
  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const selectedTpl = tpl.data?.templates.find((t) => t.key === tplKey);
  useEffect(() => { if (selectedTpl) { const p: Record<string, unknown> = {}; for (const d of selectedTpl.params) if (d.default !== undefined) p[d.key] = d.default; setTplParams(p); if (!name) setName(selectedTpl.name); setSchedule(selectedTpl.schedule); setPriority(selectedTpl.priority); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tplKey]);
  const body = () => ({ name, description, evaluationSchedule: schedule, priority, holdoutPercent: holdout, excludeAudienceIds: excl, ...(mode === 'template' ? { templateKey: tplKey, templateParams: tplParams } : { definition: root }) });
  const doPreview = async () => { setBusy('preview'); setErr(null); try { setPreview(await apiFetch('/api/v1/audiences/preview', { method: 'POST', json: { ...(mode === 'template' ? { templateKey: tplKey, templateParams: tplParams } : { definition: root }), excludeAudienceIds: excl, holdoutPercent: holdout } })); } catch (e) { setErr((e as Error).message + ((e as { details?: Array<{ path: string; message: string }> }).details ? ': ' + (e as { details: Array<{ path: string; message: string }> }).details.map((d) => `${d.path} ${d.message}`).join('; ') : '')); } finally { setBusy(null); } };
  const save = async () => { setBusy('save'); setErr(null); try { const r = await apiFetch<{ id: string }>('/api/v1/audiences', { method: 'POST', json: { ...body(), status: activateAfter ? 'ACTIVE' : 'DRAFT' } }); router.push(`/audiences/${r.id}`); } catch (e) { setErr((e as Error).message + ((e as { details?: Array<{ path: string; message: string }> }).details ? ': ' + (e as { details: Array<{ path: string; message: string }> }).details.map((d) => `${d.path} ${d.message}`).join('; ') : '')); } finally { setBusy(null); } };
  const canPreview = mode === 'template' ? !!tplKey : root.children.length > 0;

  return (<div>
    <PageHeader title="Audience Builder" description="Define audiences visually — AND/OR/NOT groups, product & category conditions, time windows and exclusions. Rules compile to SQL and run incrementally in the database." />
    <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <Card><CardHeader><CardTitle>Basics</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1"><Label>Audience name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. High Value Lapsed Customers" /></div>
          <div className="space-y-1"><Label>Evaluation schedule</Label><select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={schedule} onChange={(e) => setSchedule(e.target.value)}>{['REALTIME', 'HOURLY', 'EVERY_6_HOURS', 'DAILY', 'MANUAL'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select></div>
          <div className="space-y-1 md:col-span-2"><Label>Description</Label><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this audience for?" /></div>
          <div className="space-y-1"><Label>Priority (lower wins when a customer is in several audiences)</Label><Input type="number" min={1} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></div>
          <div className="space-y-1"><Label>Holdout / control group (%)</Label><Input type="number" min={0} max={50} value={holdout} onChange={(e) => setHoldout(Number(e.target.value))} /></div>
        </CardContent></Card>

        <Tabs value={mode} onValueChange={(v) => setMode(v as never)}>
          <TabsList><TabsTrigger value="builder">Rule builder</TabsTrigger><TabsTrigger value="template"><Sparkles className="mr-1 h-3.5 w-3.5" />Templates</TabsTrigger></TabsList>
          <TabsContent value="builder"><Card><CardHeader><CardTitle>Rules</CardTitle><CardDescription>Consent and suppression are enforced separately by the compliance policy — you do not need to add them here.</CardDescription></CardHeader><CardContent>
            {fields.length ? <GroupEditor node={root} onChange={setRoot} fields={fields} ops={ops} fieldMap={fieldMap} audiences={auds.data?.data ?? []} depth={0} /> : <div className="text-xs text-muted-foreground">Loading fields…</div>}
          </CardContent></Card></TabsContent>
          <TabsContent value="template"><Card><CardHeader><CardTitle>Start from a template</CardTitle><CardDescription>15 battle-tested templates with recommended schedule, priority, exclusions and creative angle.</CardDescription></CardHeader><CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{tpl.data?.templates.map((t) => <button key={t.key} type="button" onClick={() => setTplKey(t.key)} className={`rounded-md border p-3 text-left text-xs transition-colors hover:bg-accent ${tplKey === t.key ? 'border-primary bg-accent' : ''}`}><div className="font-medium">{t.name}</div><div className="mt-0.5 text-muted-foreground">{t.description}</div><div className="mt-1"><Badge variant="muted">{t.category}</Badge></div></button>)}</div>
            {selectedTpl && <div className="rounded-md border bg-muted/40 p-3"><div className="mb-2 text-xs font-medium">Parameters</div><div className="grid gap-2 sm:grid-cols-2">{selectedTpl.params.map((p: any) => <div key={p.key} className="space-y-1"><Label>{p.label}{p.required && ' *'}</Label>
              {p.type === 'number' ? <Input type="number" value={(tplParams[p.key] as number) ?? ''} onChange={(e) => setTplParams({ ...tplParams, [p.key]: e.target.value === '' ? undefined : Number(e.target.value) })} />
                : <EntityPicker kind={p.type === 'category' ? 'category' : 'product'} value={(tplParams[p.key] as number[]) ?? []} onChange={(v) => setTplParams({ ...tplParams, [p.key]: v })} />}</div>)}</div>
              <div className="mt-3 text-[11px] text-muted-foreground">Recommended: {selectedTpl.recommendation.channels.map(titleCase).join(' + ')} · {selectedTpl.recommendation.objective} · exclude {selectedTpl.recommendation.suggestedExclusions.map(titleCase).join(', ') || 'nothing'} · “{selectedTpl.recommendation.creativeAngle}”</div></div>}
          </CardContent></Card></TabsContent>
        </Tabs>

        <Card><CardHeader><CardTitle>Exclusions</CardTitle><CardDescription>Members of these audiences are removed from the activation set (always evaluated against their current membership).</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2">
          {(auds.data?.data ?? []).map((a) => <button key={a.id} type="button" onClick={() => setExcl((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]))} className={`rounded-full border px-3 py-1 text-xs ${excl.includes(a.id) ? 'border-destructive bg-destructive/10 text-destructive' : 'hover:bg-accent'}`}>{excl.includes(a.id) ? '− ' : ''}{a.name}</button>)}
          {!auds.data?.data.length && <span className="text-xs text-muted-foreground">No other audiences yet.</span>}
        </CardContent></Card>
      </div>

      <div className="space-y-4">
        <Card className="sticky top-0"><CardHeader><CardTitle>Preview & activate</CardTitle><CardDescription>Estimated size is computed in the database with the default compliance policy.</CardDescription></CardHeader><CardContent className="space-y-3">
          <Button className="w-full" variant="secondary" disabled={!canPreview || !!busy} onClick={doPreview}><Eye className="h-4 w-4" />{busy === 'preview' ? 'Computing…' : 'Preview audience'}</Button>
          {preview && (<div className="space-y-3">
            <div className="rounded-md bg-muted p-3 text-xs"><div className="text-[11px] uppercase tracking-wider text-muted-foreground">Rule</div><div className="mt-1 font-medium">{preview.description}</div></div>
            <div className="grid grid-cols-2 gap-2"><div className="rounded-md border p-2"><div className="text-[10px] uppercase text-muted-foreground">Total matches</div><div className="num text-lg font-semibold">{fmtNum(preview.total)}</div></div><div className="rounded-md border p-2"><div className="text-[10px] uppercase text-muted-foreground">Est. activation</div><div className="num text-lg font-semibold text-success">{fmtNum(preview.estimatedActivation)}</div></div></div>
            <Funnel steps={[{ label: 'Total records', value: preview.total }, { label: 'After exclusions', value: preview.total - preview.excludedByAudience }, { label: 'Not suppressed', value: preview.total - preview.excludedByAudience - preview.suppressed - preview.deleted }, { label: 'Eligible', value: preview.eligible }, { label: 'Activation', value: preview.estimatedActivation }]} />
            <div className="grid grid-cols-2 gap-1 text-[11px] text-muted-foreground"><span>Suppressed: <b>{fmtNum(preview.suppressed)}</b></span><span>Consent denied: <b>{fmtNum(preview.consentDenied)}</b></span><span>Consent unknown: <b>{fmtNum(preview.consentUnknown)}</b></span><span>Missing flags: <b>{fmtNum(preview.missingFlag)}</b></span><span>Invalid identifiers: <b>{fmtNum(preview.invalidIdentifier + preview.noIdentifier)}</b></span><span>Duplicates: <b>{fmtNum(preview.duplicates)}</b></span><span>Holdout: <b>{fmtNum(preview.holdout)}</b></span>{preview.estimated && <span className="col-span-2 text-warning">≈ sampled estimate</span>}</div>
            <details><summary className="cursor-pointer text-[11px] text-muted-foreground">Compiled SQL</summary><pre className="mt-1 max-h-40 overflow-auto rounded bg-foreground/95 p-2 font-mono text-[10px] text-background">{preview.sql}</pre></details>
          </div>)}
          <ErrorBox message={err} />
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={activateAfter} onChange={(e) => setActivateAfter(e.target.checked)} /> Start evaluating immediately (status ACTIVE)</label>
          <Button className="w-full" disabled={!name || !canPreview || !!busy} onClick={save}><Save className="h-4 w-4" />{busy === 'save' ? 'Saving…' : 'Save audience'}</Button>
          <div className="text-[11px] text-muted-foreground">After saving you can dry-run and activate to Meta / Google from the audience page.</div>
        </CardContent></Card>
      </div>
    </div>
  </div>);
}

function GroupEditor({ node, onChange, fields, ops, fieldMap, audiences, depth }: { node: Group; onChange: (g: Group) => void; fields: Field[]; ops: Record<string, string[]>; fieldMap: Map<string, Field>; audiences: any[]; depth: number }) {
  const update = (i: number, child: Node) => onChange({ ...node, children: node.children.map((c, j) => (j === i ? child : c)) });
  const remove = (i: number) => onChange({ ...node, children: node.children.filter((_, j) => j !== i) });
  const addCond = () => { const f = fields.find((x) => x.key === 'total_revenue') ?? fields[0]!; const op = ops[f.type]![0]!; onChange({ ...node, children: [...node.children, { type: 'condition', field: f.key, operator: op, value: defaultValue(f, op) }] }); };
  const addGroup = () => onChange({ ...node, children: [...node.children, { type: 'group', operator: node.operator === 'AND' ? 'OR' : 'AND', children: [] }] });
  return (<div className={`rounded-lg border ${depth ? 'bg-muted/30' : ''} p-3`}>
    <div className="mb-2 flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Match</span>
      <select className="h-7 rounded-md border bg-background px-1.5 text-xs font-medium" value={node.operator} onChange={(e) => onChange({ ...node, operator: e.target.value as never })}><option value="AND">ALL (AND)</option><option value="OR">ANY (OR)</option></select>
      <label className="flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={!!node.negate} onChange={(e) => onChange({ ...node, negate: e.target.checked })} /> NOT</label>
      <span className="text-muted-foreground">of the following{depth ? ' (nested group)' : ''}</span>
    </div>
    <div className="space-y-2">
      {node.children.map((c, i) => c.type === 'group'
        ? <div key={i} className="flex items-start gap-2"><div className="flex-1"><GroupEditor node={c} onChange={(g) => update(i, g)} fields={fields} ops={ops} fieldMap={fieldMap} audiences={audiences} depth={depth + 1} /></div><Button variant="ghost" size="icon" onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></Button></div>
        : <CondEditor key={i} cond={c} onChange={(x) => update(i, x)} onRemove={() => remove(i)} fields={fields} ops={ops} fieldMap={fieldMap} audiences={audiences} />)}
      {!node.children.length && <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">Empty group — add a condition.</div>}
    </div>
    <div className="mt-2 flex gap-2"><Button size="xs" variant="outline" onClick={addCond}><Plus className="h-3 w-3" />Condition</Button>{depth < 5 && <Button size="xs" variant="ghost" onClick={addGroup}><Plus className="h-3 w-3" />Nested group</Button>}</div>
  </div>);
}

function CondEditor({ cond, onChange, onRemove, fields, ops, fieldMap, audiences }: { cond: Cond; onChange: (c: Cond) => void; onRemove: () => void; fields: Field[]; ops: Record<string, string[]>; fieldMap: Map<string, Field>; audiences: any[] }) {
  const f = fieldMap.get(cond.field)!; const allowed = ops[f.type] ?? [];
  const groups = [...new Set(fields.map((x) => x.group))];
  const setField = (key: string) => { const nf = fieldMap.get(key)!; const op = (ops[nf.type] ?? [])[0]!; onChange({ type: 'condition', field: key, operator: op, value: defaultValue(nf, op), params: nf.type.startsWith('custom') ? { path: 'tier' } : undefined }); };
  const setOp = (op: string) => onChange({ ...cond, operator: op, value: defaultValue(f, op) });
  const v = cond.value as never;
  const needsValue = !['is_null', 'is_not_null', 'any', 'none'].includes(cond.operator);
  return (<div className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2 text-xs">
    <label className="flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={!!cond.negate} onChange={(e) => onChange({ ...cond, negate: e.target.checked })} />NOT</label>
    <select className="h-8 rounded-md border bg-background px-1.5" value={cond.field} onChange={(e) => setField(e.target.value)}>{groups.map((g) => <optgroup key={g} label={g}>{fields.filter((x) => x.group === g).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>)}</select>
    {f.type.startsWith('custom') && <Input className="h-8 w-28" placeholder="attribute key" value={(cond.params?.path as string) ?? ''} onChange={(e) => onChange({ ...cond, params: { ...cond.params, path: e.target.value } })} />}
    <select className="h-8 rounded-md border bg-background px-1.5" value={cond.operator} onChange={(e) => setOp(e.target.value)}>{allowed.map((o) => <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>)}</select>
    {needsValue && (<>
      {f.type === 'boolean' && <select className="h-8 rounded-md border bg-background px-1.5" value={String(v)} onChange={(e) => onChange({ ...cond, value: e.target.value === 'true' })}><option value="true">true</option><option value="false">false</option></select>}
      {(f.type === 'number' || f.type === 'custom_number') && (cond.operator === 'between' ? <><Input type="number" className="h-8 w-24" value={(v as number[])[0]} onChange={(e) => onChange({ ...cond, value: [Number(e.target.value), (v as number[])[1]] })} /><span>and</span><Input type="number" className="h-8 w-24" value={(v as number[])[1]} onChange={(e) => onChange({ ...cond, value: [(v as number[])[0], Number(e.target.value)] })} /></> : <Input type="number" className="h-8 w-28" value={v as number} onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })} />)}
      {(f.type === 'string' || f.type === 'custom_string') && (cond.operator === 'in' || cond.operator === 'not_in' ? <Input className="h-8 w-56" placeholder="comma separated" value={(v as string[]).join(',')} onChange={(e) => onChange({ ...cond, value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /> : <Input className="h-8 w-40" value={v as string} onChange={(e) => onChange({ ...cond, value: e.target.value })} />)}
      {f.type === 'enum' && (cond.operator === 'in' || cond.operator === 'not_in' ? <select multiple className="h-20 rounded-md border bg-background px-1.5" value={v as string[]} onChange={(e) => onChange({ ...cond, value: [...e.target.selectedOptions].map((o) => o.value) })}>{f.enumValues?.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</select> : <select className="h-8 rounded-md border bg-background px-1.5" value={v as string} onChange={(e) => onChange({ ...cond, value: e.target.value })}>{f.enumValues?.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</select>)}
      {f.type === 'timestamp' && (cond.operator === 'between_ago' ? <><Input type="number" className="h-8 w-20" value={(v as { min: number }).min} onChange={(e) => onChange({ ...cond, value: { ...(v as object), min: Number(e.target.value) } })} /><span>–</span><Input type="number" className="h-8 w-20" value={(v as { max: number }).max} onChange={(e) => onChange({ ...cond, value: { ...(v as object), max: Number(e.target.value) } })} /><UnitSelect value={(v as { unit: string }).unit} onChange={(u) => onChange({ ...cond, value: { ...(v as object), unit: u } })} /></>
        : cond.operator === 'before' || cond.operator === 'after' ? <Input type="date" className="h-8 w-40" value={String(v).slice(0, 10)} onChange={(e) => onChange({ ...cond, value: e.target.value })} />
        : <><Input type="number" className="h-8 w-20" value={(v as { value: number }).value} onChange={(e) => onChange({ ...cond, value: { ...(v as object), value: Number(e.target.value) } })} /><UnitSelect value={(v as { unit: string }).unit} onChange={(u) => onChange({ ...cond, value: { ...(v as object), unit: u } })} /></>)}
      {(f.type === 'product' || f.type === 'category') && <EntityPicker kind={f.type} value={(v as number[]) ?? []} onChange={(ids) => onChange({ ...cond, value: ids })} />}
      {f.type === 'audience' && <select multiple className="h-20 min-w-[200px] rounded-md border bg-background px-1.5" value={(v as string[]) ?? []} onChange={(e) => onChange({ ...cond, value: [...e.target.selectedOptions].map((o) => o.value) })}>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
    </>)}
    {f.supportsWindow && <label className="flex items-center gap-1 text-muted-foreground">within last <Input type="number" className="h-8 w-16" value={(cond.params?.withinDays as number) ?? ''} placeholder="∞" onChange={(e) => onChange({ ...cond, params: { ...cond.params, withinDays: e.target.value ? Number(e.target.value) : undefined } })} /> days</label>}
    {f.supportsMinCount && <label className="flex items-center gap-1 text-muted-foreground">min <Input type="number" className="h-8 w-14" value={(cond.params?.minCount as number) ?? ''} placeholder="1" onChange={(e) => onChange({ ...cond, params: { ...cond.params, minCount: e.target.value ? Number(e.target.value) : undefined } })} /> ×</label>}
    {f.key === 'product_carted' && <label className="flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={!!cond.params?.openOnly} onChange={(e) => onChange({ ...cond, params: { ...cond.params, openOnly: e.target.checked } })} /> open cart only</label>}
    <span className="ml-auto max-w-[200px] truncate text-[10px] text-muted-foreground" title={f.description}>{f.description}</span>
    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /></Button>
  </div>);
}
function UnitSelect({ value, onChange }: { value: string; onChange: (u: string) => void }) { return <select className="h-8 rounded-md border bg-background px-1.5" value={value} onChange={(e) => onChange(e.target.value)}>{['minutes', 'hours', 'days', 'weeks'].map((u) => <option key={u} value={u}>{u}</option>)}</select>; }

