'use client';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, PieChart, Pie, Cell } from 'recharts';
import { fmtCompact, fmtDay } from '@/lib/utils';

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];
const tooltipStyle = { contentStyle: { background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: 'hsl(var(--popover-foreground))' }, labelStyle: { color: 'hsl(var(--muted-foreground))' } };
const axis = { tick: { fontSize: 11, fill: 'hsl(var(--muted-foreground))' }, axisLine: false as const, tickLine: false as const };

export function TrendArea({ data, xKey = 'day', series, height = 220, stacked = false }: { data: Array<Record<string, unknown>>; xKey?: string; series: Array<{ key: string; label: string; color?: string }>; height?: number; stacked?: boolean }) {
  return (<ResponsiveContainer width="100%" height={height}><AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
    <defs>{series.map((s, i) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={s.color ?? COLORS[i % COLORS.length]} stopOpacity={0.35} /><stop offset="95%" stopColor={s.color ?? COLORS[i % COLORS.length]} stopOpacity={0} /></linearGradient>)}</defs>
    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
    <XAxis dataKey={xKey} {...axis} tickFormatter={(v) => fmtDay(String(v))} minTickGap={24} /><YAxis {...axis} tickFormatter={(v) => fmtCompact(Number(v))} width={48} />
    <Tooltip {...tooltipStyle} formatter={(v: number) => new Intl.NumberFormat('en-IN').format(v)} labelFormatter={(l) => fmtDay(String(l))} />
    {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    {series.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? COLORS[i % COLORS.length]} fill={`url(#g-${s.key})`} strokeWidth={2} stackId={stacked ? 'a' : undefined} />)}
  </AreaChart></ResponsiveContainer>);
}
export function TrendBars({ data, xKey = 'day', series, height = 200 }: { data: Array<Record<string, unknown>>; xKey?: string; series: Array<{ key: string; label: string; color?: string }>; height?: number }) {
  return (<ResponsiveContainer width="100%" height={height}><BarChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
    <XAxis dataKey={xKey} {...axis} tickFormatter={(v) => fmtDay(String(v))} minTickGap={24} /><YAxis {...axis} tickFormatter={(v) => fmtCompact(Number(v))} width={48} />
    <Tooltip {...tooltipStyle} formatter={(v: number) => new Intl.NumberFormat('en-IN').format(v)} labelFormatter={(l) => fmtDay(String(l))} />{series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color ?? COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />)}
  </BarChart></ResponsiveContainer>);
}
export function TrendLines({ data, xKey = 'day', series, height = 220, yFormatter }: { data: Array<Record<string, unknown>>; xKey?: string; series: Array<{ key: string; label: string; color?: string }>; height?: number; yFormatter?: (v: number) => string }) {
  return (<ResponsiveContainer width="100%" height={height}><LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
    <XAxis dataKey={xKey} {...axis} tickFormatter={(v) => fmtDay(String(v))} minTickGap={24} /><YAxis {...axis} tickFormatter={(v) => (yFormatter ?? fmtCompact)(Number(v))} width={52} />
    <Tooltip {...tooltipStyle} formatter={(v: number) => (yFormatter ?? ((x: number) => new Intl.NumberFormat('en-IN').format(x)))(v)} labelFormatter={(l) => fmtDay(String(l))} />{series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    {series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />)}
  </LineChart></ResponsiveContainer>);
}
export function Donut({ data, height = 200 }: { data: Array<{ name: string; value: number }>; height?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (<div className="flex items-center gap-4"><ResponsiveContainer width="50%" height={height}><PieChart><Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} stroke="none">{data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip {...tooltipStyle} formatter={(v: number) => new Intl.NumberFormat('en-IN').format(v)} /></PieChart></ResponsiveContainer>
    <div className="space-y-1.5 text-xs">{data.map((d, i) => <div key={d.name} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} /><span className="w-28 truncate text-muted-foreground">{d.name}</span><span className="num font-medium">{new Intl.NumberFormat('en-IN').format(d.value)}</span><span className="num text-muted-foreground">{total ? Math.round((d.value / total) * 100) : 0}%</span></div>)}</div></div>);
}
export function Sparkline({ data, dataKey, color = COLORS[0], height = 36 }: { data: Array<Record<string, unknown>>; dataKey: string; color?: string; height?: number }) {
  return (<ResponsiveContainer width="100%" height={height}><AreaChart data={data} margin={{ left: 0, right: 0, top: 2, bottom: 0 }}><Area type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} /></AreaChart></ResponsiveContainer>);
}
