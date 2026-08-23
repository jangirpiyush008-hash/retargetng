import * as React from 'react';
import { cn } from '@/lib/utils';
export function PageHeader({ title, description, actions, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>{eyebrow && <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{eyebrow}</div>}<h1 className="text-xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}</div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>);
}
export function Stat({ label, value, hint, tone, className }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger'; className?: string }) {
  return (<div className={cn('rounded-xl border bg-card p-4', className)}>
    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
    <div className={cn('num mt-1.5 text-2xl font-semibold tracking-tight', tone === 'success' && 'text-success', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-destructive')}>{value}</div>
    {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
  </div>);
}
export function StatusDot({ status }: { status: string }) {
  const s = status.toUpperCase();
  const color = ['ACTIVE', 'CONNECTED', 'SUCCESS', 'SYNCED', 'COMPLETED', 'HEALTHY'].includes(s) ? 'bg-success' : ['PAUSED', 'PENDING', 'PENDING_CREATE', 'QUEUED', 'RUNNING', 'SUCCESS_WITH_WARNINGS', 'DEGRADED', 'DRAFT'].includes(s) ? 'bg-warning' : ['ERROR', 'FAILED', 'DISCONNECTED', 'UNHEALTHY', 'CANCELLED', 'DEAD'].includes(s) ? 'bg-destructive' : 'bg-muted-foreground/50';
  return <span className={cn('inline-block h-2 w-2 rounded-full', color, s === 'RUNNING' && 'animate-pulse')} />;
}
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const s = status.toUpperCase();
  const variant = ['ACTIVE', 'CONNECTED', 'SUCCESS', 'SYNCED', 'COMPLETED', 'HEALTHY', 'GRANTED', 'SUCCEEDED'].includes(s) ? 'success' : ['PAUSED', 'PENDING', 'PENDING_CREATE', 'QUEUED', 'RUNNING', 'SUCCESS_WITH_WARNINGS', 'DEGRADED', 'DRAFT', 'UNKNOWN', 'PENDING_ADD', 'PENDING_REMOVE', 'SENT'].includes(s) ? 'warning' : ['ERROR', 'FAILED', 'DISCONNECTED', 'UNHEALTHY', 'CANCELLED', 'DEAD', 'DENIED', 'EXPIRED', 'DELETED'].includes(s) ? 'destructive' : 'muted';
  return <span className={cn('inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-[11px] font-medium', variant === 'success' && 'bg-success/10 text-success', variant === 'warning' && 'bg-warning/15 text-warning', variant === 'destructive' && 'bg-destructive/10 text-destructive', variant === 'muted' && 'bg-muted text-muted-foreground')}><StatusDot status={s} />{s.replace(/_/g, ' ')}</span>;
}
export function DestinationIcon({ type, className }: { type: string; className?: string }) {
  const t = type.toUpperCase();
  const isMeta = t.includes('META'); const isGoogle = t.includes('GOOGLE');
  return <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white', isMeta ? 'bg-[#0866FF]' : isGoogle ? 'bg-[#34A853]' : 'bg-muted-foreground', className)} title={type}>{isMeta ? 'M' : isGoogle ? 'G' : t.slice(0, 1)}</span>;
}
export function Funnel({ steps }: { steps: Array<{ label: string; value: number; hint?: string }> }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (<div className="space-y-2">
    {steps.map((s, i) => (<div key={s.label} className="grid grid-cols-[140px_1fr_90px] items-center gap-3 text-xs">
      <div className="truncate text-muted-foreground" title={s.hint}>{s.label}</div>
      <div className="h-5 overflow-hidden rounded bg-muted"><div className={cn('h-full rounded', i === steps.length - 1 ? 'bg-success' : 'bg-primary/70')} style={{ width: `${(s.value / max) * 100}%` }} /></div>
      <div className="num text-right font-medium">{new Intl.NumberFormat('en-IN').format(s.value)}</div>
    </div>))}
  </div>);
}
export function ErrorBox({ message }: { message: string | null }) { return message ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{message}</div> : null; }
export function LoadingRows({ n = 5 }: { n?: number }) { return <div className="space-y-2">{Array.from({ length: n }).map((_, i) => <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />)}</div>; }
