'use client';
import { useEffect, useMemo, useState } from 'react';
import { Layers, Check } from 'lucide-react';
import { apiFetch, useApi } from '@/lib/api-client';
import { fmtNum, titleCase } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorBox } from '@/components/shared/page';
import { EntityPicker } from '@/components/shared/entity-picker';

interface Planned { name: string; slug: string; templateKey?: string; description: string }
interface BulkResult { planned: Planned[]; created: Array<{ id: string; slug: string }>; skipped: Array<{ slug: string; reason: string }>; failed: Array<{ slug: string; error: string }>; dryRun: boolean }

const GENERATORS = [
  { key: 'PRODUCT_BUYER', label: 'Product buyers', entity: 'product', help: 'One audience per selected product — everyone who bought it.' },
  { key: 'CATEGORY_BUYER', label: 'Category buyers', entity: 'category', help: 'One audience per selected category.' },
  { key: 'CROSS_SELL', label: 'Cross-sell', entity: 'product', help: 'One audience per selected product: bought it, but never bought the products you exclude.' },
  { key: 'REPLENISHMENT', label: 'Replenishment', entity: 'product', help: 'One audience per product: bought it in the re-order window and has not bought since.' },
] as const;

/** Create many audiences in one action: the standard library, or one audience per product/category. */
export function BulkAudienceDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const templates = useApi<{ templates: unknown[]; standard: Array<{ slug: string; name: string; templateKey: string; priority: number }> }>(open ? '/api/v1/audiences/templates' : null);
  const existing = useApi<{ data: Array<{ slug: string }> }>(open ? '/api/v1/audiences' : null);
  const have = useMemo(() => new Set((existing.data?.data ?? []).map((a) => a.slug)), [existing.data]);

  const [mode, setMode] = useState<'standard' | 'generate'>('standard');
  const [picked, setPicked] = useState<string[]>([]);
  const [gen, setGen] = useState<(typeof GENERATORS)[number]['key']>('PRODUCT_BUYER');
  const [productIds, setProductIds] = useState<number[]>([]);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [excludeProductIds, setExcludeProductIds] = useState<number[]>([]);
  const [withinDays, setWithinDays] = useState<string>('');
  const [activate, setActivate] = useState(true);
  const [evaluate, setEvaluate] = useState(true);
  const [plan, setPlan] = useState<BulkResult | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const generator = GENERATORS.find((g) => g.key === gen)!;
  const body = (dryRun: boolean) => ({
    dryRun,
    status: activate ? 'ACTIVE' : 'DRAFT',
    evaluate,
    ...(mode === 'standard'
      ? { standard: picked }
      : {
          generate: {
            templateKey: gen,
            productIds: generator.entity === 'product' ? productIds : [],
            categoryIds: generator.entity === 'category' ? categoryIds : [],
            excludeProductIds: gen === 'CROSS_SELL' ? excludeProductIds : [],
            withinDays: withinDays ? Number(withinDays) : undefined,
          },
        }),
  });
  const count = mode === 'standard' ? picked.length : generator.entity === 'product' ? productIds.length : categoryIds.length;
  const ready = count > 0 && !(gen === 'CROSS_SELL' && mode === 'generate' && excludeProductIds.length === 0);

  useEffect(() => { setPlan(null); setResult(null); }, [mode, gen, picked, productIds, categoryIds, excludeProductIds, withinDays]);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'plan' : 'create'); setErr(null);
    try {
      const r = await apiFetch<BulkResult>('/api/v1/audiences/bulk', { method: 'POST', json: body(dryRun) });
      if (dryRun) setPlan(r); else { setResult(r); onDone(); existing.reload(); }
    } catch (e) {
      const d = (e as { details?: Array<{ path: string; message: string }> }).details;
      setErr((e as Error).message + (d ? ': ' + d.map((x) => `${x.path} ${x.message}`).join('; ') : ''));
    } finally { setBusy(null); }
  };

  const reset = () => { setPicked([]); setProductIds([]); setCategoryIds([]); setExcludeProductIds([]); setPlan(null); setResult(null); setErr(null); };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Layers className="h-4 w-4" />Bulk create</Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create audiences in bulk</DialogTitle>
          <DialogDescription>Add the standard library in one click, or generate one audience per product or category. Existing slugs are skipped, so you can safely re-run this.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="success">{result.created.length} created</Badge>
              {result.skipped.length > 0 && <Badge variant="warning">{result.skipped.length} skipped</Badge>}
              {result.failed.length > 0 && <Badge variant="destructive">{result.failed.length} failed</Badge>}
            </div>
            <div className="max-h-64 overflow-auto rounded-md border">
              {result.created.map((c) => <div key={c.slug} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-0"><Check className="h-3.5 w-3.5 text-success" />{c.slug}</div>)}
              {result.skipped.map((s) => <div key={s.slug} className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground last:border-0"><span>{s.slug}</span><span>{s.reason}</span></div>)}
              {result.failed.map((f) => <div key={f.slug} className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-destructive last:border-0"><span>{f.slug}</span><span className="max-w-[60%] truncate" title={f.error}>{f.error}</span></div>)}
            </div>
            <p className="text-[11px] text-muted-foreground">{activate && evaluate ? 'Created audiences are ACTIVE and a full evaluation has been queued — member counts appear as the engine works through them.' : 'Created as drafts — activate them when you are ready.'}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as never)}>
              <TabsList>
                <TabsTrigger value="standard">Standard library</TabsTrigger>
                <TabsTrigger value="generate">Per product / category</TabsTrigger>
              </TabsList>

              <TabsContent value="standard">
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <Button size="xs" variant="outline" onClick={() => setPicked((templates.data?.standard ?? []).filter((s) => !have.has(s.slug)).map((s) => s.slug))}>Select all missing</Button>
                  <Button size="xs" variant="ghost" onClick={() => setPicked([])}>Clear</Button>
                  <span className="ml-auto text-muted-foreground">{picked.length} selected</span>
                </div>
                <div className="grid max-h-72 gap-1.5 overflow-auto sm:grid-cols-2">
                  {(templates.data?.standard ?? []).map((s) => {
                    const exists = have.has(s.slug);
                    const on = picked.includes(s.slug);
                    return (
                      <button key={s.slug} type="button" disabled={exists}
                        onClick={() => setPicked((p) => (p.includes(s.slug) ? p.filter((x) => x !== s.slug) : [...p, s.slug]))}
                        className={`flex items-start gap-2 rounded-md border p-2 text-left text-xs transition-colors ${exists ? 'opacity-50' : on ? 'border-primary bg-accent' : 'hover:bg-accent'}`}>
                        <input type="checkbox" checked={on || exists} disabled={exists} readOnly className="mt-0.5" />
                        <span className="min-w-0">
                          <span className="block font-medium">{s.name}</span>
                          <span className="block truncate text-muted-foreground">{s.slug} · {titleCase(s.templateKey)} · priority {s.priority}{exists ? ' · already exists' : ''}</span>
                        </span>
                      </button>
                    );
                  })}
                  {!templates.data && <div className="text-xs text-muted-foreground">Loading library…</div>}
                </div>
              </TabsContent>

              <TabsContent value="generate">
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-4">
                    {GENERATORS.map((g) => (
                      <button key={g.key} type="button" onClick={() => setGen(g.key)}
                        className={`rounded-md border p-2 text-left text-xs transition-colors ${gen === g.key ? 'border-primary bg-accent' : 'hover:bg-accent'}`}>
                        <div className="font-medium">{g.label}</div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">per {g.entity}</div>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{generator.help}</p>
                  <div className="space-y-1">
                    <Label>{generator.entity === 'product' ? 'Products (one audience each)' : 'Categories (one audience each)'}</Label>
                    {generator.entity === 'product'
                      ? <EntityPicker kind="product" value={productIds} onChange={setProductIds} />
                      : <EntityPicker kind="category" value={categoryIds} onChange={setCategoryIds} />}
                  </div>
                  {gen === 'CROSS_SELL' && (
                    <div className="space-y-1">
                      <Label>Exclude buyers of (the product you want to sell them)</Label>
                      <EntityPicker kind="product" value={excludeProductIds} onChange={setExcludeProductIds} />
                    </div>
                  )}
                  {(gen === 'PRODUCT_BUYER' || gen === 'CATEGORY_BUYER') && (
                    <div className="space-y-1">
                      <Label>Only purchases within the last N days (optional)</Label>
                      <Input className="w-40" type="number" min={1} placeholder="all time" value={withinDays} onChange={(e) => setWithinDays(e.target.value)} />
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap items-center gap-4 border-t pt-3 text-xs">
              <label className="flex items-center gap-2"><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />Create as ACTIVE</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={evaluate} onChange={(e) => setEvaluate(e.target.checked)} disabled={!activate} />Evaluate immediately</label>
              <span className="ml-auto text-muted-foreground">{fmtNum(count)} audience{count === 1 ? '' : 's'} selected</span>
            </div>

            {plan && (
              <div className="space-y-2">
                <div className="text-xs font-medium">Plan ({plan.planned.length} audiences{plan.skipped.length ? `, ${plan.skipped.length} already exist` : ''})</div>
                <div className="max-h-56 overflow-auto rounded-md border">
                  {plan.planned.map((p) => {
                    const skip = plan.skipped.find((s) => s.slug === p.slug);
                    return (
                      <div key={p.slug} className={`border-b px-3 py-1.5 text-xs last:border-0 ${skip ? 'text-muted-foreground' : ''}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{p.name}</span>
                          {skip ? <Badge variant="muted">skipped</Badge> : <Badge variant="outline">{p.slug}</Badge>}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground" title={p.description}>{p.description}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <ErrorBox message={err} />
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={() => { setResult(null); reset(); }}>Create more</Button>
              <Button onClick={() => { setOpen(false); reset(); }}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={!ready || !!busy} onClick={() => run(true)}>{busy === 'plan' ? 'Building plan…' : 'Preview plan'}</Button>
              <Button disabled={!ready || !!busy} onClick={() => run(false)}>{busy === 'create' ? 'Creating…' : `Create ${count || ''} audience${count === 1 ? '' : 's'}`}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
