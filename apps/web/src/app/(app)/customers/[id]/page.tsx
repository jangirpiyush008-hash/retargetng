'use client';
import { use } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/api-client';
import { fmtDate, fmtMoney, fmtNum, timeAgo, titleCase } from '@/lib/utils';
import { PageHeader, StatusBadge, DestinationIcon, LoadingRows, ErrorBox } from '@/components/shared/page';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function CustomerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, loading } = useApi<any>(`/api/v1/customers/${id}`);
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <LoadingRows n={8} />;
  const c = data.customer;
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-4 border-b py-1.5 text-xs last:border-0"><span className="text-muted-foreground">{k}</span><span className="text-right font-medium">{v}</span></div>;
  return (<div>
    <PageHeader eyebrow={<Link href="/customers" className="hover:underline">Customers</Link>} title={c.external_customer_id ?? `Customer #${c.id}`} description={<span className="flex flex-wrap items-center gap-2"><Badge variant="outline">{titleCase(c.lifecycle_state)}</Badge><StatusBadge status={c.consent_status} />{c.suppressed && <Badge variant="destructive">Suppressed</Badge>}{c.deleted && <Badge variant="muted">Deleted (PII erased)</Badge>}{data.eligibility.eligible ? <Badge variant="success">Eligible for activation</Badge> : <Badge variant="warning">Ineligible: {data.eligibility.reasons.join(', ')}</Badge>}</span>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Card><CardHeader><CardTitle>Identity</CardTitle><CardDescription>{c.pii_visible ? 'You have customers:read_pii — raw values decrypted for this view (audited).' : 'Raw PII hidden — hashes shown masked.'}</CardDescription></CardHeader><CardContent>
        {row('Internal id', c.id)}{row('External id', c.external_customer_id ?? '—')}{row('Email', c.pii_visible && c.email ? c.email : <span className="font-mono">{c.email_hash ?? '—'}</span>)}{row('Phone', c.pii_visible && c.phone ? c.phone : <span className="font-mono">{c.phone_hash ?? '—'}</span>)}
        {row('Email valid', c.email_valid == null ? '—' : c.email_valid ? 'yes' : 'no')}{row('Phone valid', c.phone_valid == null ? '—' : c.phone_valid ? 'yes' : 'no')}{row('Country / region', `${c.country ?? '—'} ${c.region ? '· ' + c.region : ''} ${c.city ? '· ' + c.city : ''}`)}{row('Source', c.source ?? '—')}{row('Created', fmtDate(c.created_at))}{row('Updated', fmtDate(c.updated_at))}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Commerce</CardTitle></CardHeader><CardContent>
        {row('Orders', fmtNum(c.order_count))}{row('Total revenue', fmtMoney(c.total_revenue))}{row('Lifetime value', fmtMoney(c.lifetime_value))}{row('AOV', fmtMoney(c.average_order_value))}{row('Refunds', `${fmtNum(c.refund_count)} (${fmtMoney(c.refund_amount)})`)}{row('First / last order', `${fmtDate(c.first_order_at)} → ${fmtDate(c.last_order_at)}`)}{row('Purchase frequency', c.purchase_frequency_days ? `${Number(c.purchase_frequency_days).toFixed(1)} days` : '—')}
        {row('Open cart', c.has_open_cart ? `yes (${timeAgo(c.last_cart_at)})` : 'no')}{row('Cart events', fmtNum(c.cart_event_count))}{row('Last activity', timeAgo(c.last_activity_at))}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Consent & privacy</CardTitle></CardHeader><CardContent>
        {row('Status', <StatusBadge status={c.consent_status} />)}{row('Marketing', c.marketing_allowed ? 'allowed' : 'no')}{row('Advertising personalization', c.advertising_personalization_allowed ? 'allowed' : 'no')}{row('Data sharing', c.data_sharing_allowed ? 'allowed' : 'no')}{row('Consent updated', fmtDate(c.consent_updated_at))}{row('Suppressed', c.suppressed ? `yes · ${fmtDate(c.suppressed_at)}` : 'no')}{row('Deleted', c.deleted ? fmtDate(c.deleted_at) : 'no')}
        <div className="mt-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Consent events</div>
        {data.consent.length ? data.consent.map((e: any, i: number) => <div key={i} className="flex justify-between py-1 text-xs"><span>{titleCase(e.event_type)} <span className="text-muted-foreground">via {e.source ?? '—'}</span></span><span className="text-muted-foreground">{fmtDate(e.occurred_at)}</span></div>) : <div className="text-xs text-muted-foreground">None recorded</div>}
        {data.suppression.length > 0 && <><div className="mt-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Suppression records</div>{data.suppression.map((s: any) => <div key={s.id} className="flex justify-between py-1 text-xs"><span>{titleCase(s.reason)} {s.revoked_at && <Badge variant="muted">revoked</Badge>}</span><span className="text-muted-foreground">{fmtDate(s.created_at)}</span></div>)}</>}
      </CardContent></Card>
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Audience memberships</CardTitle><CardDescription>Primary = highest-priority active audience (prevents conflicting campaigns)</CardDescription></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Audience</TableHead><TableHead>Status</TableHead><TableHead>Priority</TableHead><TableHead>Entered</TableHead></TableRow></TableHeader><TableBody>
        {data.memberships.map((m: any) => <TableRow key={m.id}><TableCell className="pl-5"><Link href={`/audiences/${m.id}`} className="hover:underline">{m.name}</Link> {m.is_primary && <Badge variant="info">primary</Badge>}</TableCell><TableCell><StatusBadge status={m.status} /></TableCell><TableCell className="num">{m.priority}</TableCell><TableCell className="text-xs text-muted-foreground">{m.status === 'ACTIVE' ? fmtDate(m.entered_at) : `exited ${fmtDate(m.exited_at)}`}</TableCell></TableRow>)}
        {!data.memberships.length && <TableRow><TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">Not in any audience</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
      <Card><CardHeader><CardTitle>Destination state</CardTitle><CardDescription>What each advertising platform currently holds for this customer</CardDescription></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Audience</TableHead><TableHead>Destination</TableHead><TableHead>State</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>
        {data.destinations.map((d: any, i: number) => <TableRow key={i}><TableCell className="pl-5">{d.audience_name}</TableCell><TableCell><span className="flex items-center gap-1.5"><DestinationIcon type={d.destination_type} />{d.account_name}</span></TableCell><TableCell><StatusBadge status={d.state} />{d.last_error_code && <span className="ml-1 text-[10px] text-destructive">{d.last_error_code}</span>}</TableCell><TableCell className="text-xs text-muted-foreground">{timeAgo(d.removed_at ?? d.added_at)}</TableCell></TableRow>)}
        {!data.destinations.length && <TableRow><TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">Not synced to any destination</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
      <Card><CardHeader><CardTitle>Recent orders</CardTitle></CardHeader><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Order</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Items</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Date</TableHead></TableRow></TableHeader><TableBody>
        {data.orders.map((o: any) => <TableRow key={o.id}><TableCell className="pl-5 font-mono text-xs">{o.external_order_id}</TableCell><TableCell><StatusBadge status={o.status} /></TableCell><TableCell className="num text-right">{o.item_count}</TableCell><TableCell className="num text-right">{fmtMoney(o.total, o.currency)}</TableCell><TableCell className="text-xs text-muted-foreground">{fmtDate(o.ordered_at)}</TableCell></TableRow>)}
        {!data.orders.length && <TableRow><TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">No orders</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
      <Card><CardHeader><CardTitle>Identity history</CardTitle><CardDescription>Identifier changes keep resolving to this customer</CardDescription></CardHeader><CardContent>
        {data.identity.length ? data.identity.map((h: any, i: number) => <div key={i} className="flex justify-between border-b py-1.5 text-xs last:border-0"><span>{h.kind}: <span className="font-mono">{h.previous_hash ?? '∅'}</span> → <span className="font-mono">{h.new_hash}</span></span><span className="text-muted-foreground">{fmtDate(h.occurred_at)}</span></div>) : <div className="text-xs text-muted-foreground">No identifier changes</div>}
      </CardContent></Card>
    </div>
  </div>);
}
