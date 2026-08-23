'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

/** Typeahead for products / categories (ids only are stored in rules). */
export function EntityPicker({ kind, value, onChange }: { kind: 'product' | 'category'; value: number[]; onChange: (ids: number[]) => void }) {
  const [q, setQ] = useState(''); const [results, setResults] = useState<any[]>([]); const [selected, setSelected] = useState<any[]>([]);
  useEffect(() => { const t = setTimeout(async () => { if (q.length < 2) { setResults([]); return; } const r = await apiFetch<{ data: any[] }>(`/api/v1/${kind === 'product' ? 'products' : 'categories'}?q=${encodeURIComponent(q)}`); setResults(r.data); }, 250); return () => clearTimeout(t); }, [q, kind]);
  useEffect(() => { if (value.length && !selected.length && kind === 'product') apiFetch<{ data: any[] }>(`/api/v1/products?ids=${value.join(',')}`).then((r) => setSelected(r.data)).catch(() => {}); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = (e: any) => { if (!value.includes(e.id)) { onChange([...value, e.id]); setSelected((s) => [...s, e]); } setQ(''); setResults([]); };
  return (<div className="relative min-w-[260px]">
    <div className="flex flex-wrap gap-1">{value.map((id) => { const e = selected.find((x) => x.id === id); return <Badge key={id} variant="secondary" className="gap-1">{e?.name ?? `#${id}`}<button type="button" onClick={() => onChange(value.filter((x) => x !== id))}>×</button></Badge>; })}</div>
    <Input className="mt-1 h-8" placeholder={`Search ${kind}s…`} value={q} onChange={(e) => setQ(e.target.value)} />
    {results.length > 0 && <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">{results.map((r) => <button type="button" key={r.id} onClick={() => add(r)} className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent">{r.name} <span className="text-muted-foreground">{r.external_product_id ?? r.external_category_id}{r.category ? ` · ${r.category}` : ''}</span></button>)}</div>}
  </div>);
}
