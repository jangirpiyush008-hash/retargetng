'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, Target, Wand2, Plug, RefreshCw, Megaphone, BarChart3, ShieldBan, ShieldCheck, Settings, ScrollText, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BRAND } from '@/lib/brand';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/audiences', label: 'Audiences', icon: Target },
  { href: '/audiences/new', label: 'Audience Builder', icon: Wand2 },
  { href: '/destinations', label: 'Destinations', icon: Plug },
  { href: '/sync-jobs', label: 'Sync Jobs', icon: RefreshCw },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/suppression', label: 'Suppression', icon: ShieldBan },
  { href: '/consent', label: 'Consent', icon: ShieldCheck },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/audit-logs', label: 'Audit Logs', icon: ScrollText },
];
export function Sidebar({ orgName, mode }: { orgName: string; mode: 'mock' | 'live' }) {
  const path = usePathname();
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground"><Radio className="h-4 w-4" /></div>
        <div className="leading-tight"><div className="text-sm font-semibold text-white">{BRAND.name}</div><div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">Audience activation</div></div>
      </div>
      <div className="mx-3 mb-2 rounded-md border border-sidebar-border bg-sidebar-accent/60 px-3 py-2 text-xs">
        <div className="truncate font-medium text-white">{orgName}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sidebar-foreground/70"><span className={cn('inline-block h-1.5 w-1.5 rounded-full', mode === 'mock' ? 'bg-warning' : 'bg-success')} />{mode === 'mock' ? 'Mock destinations — no data leaves' : 'Live destinations'}</div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {NAV.map((n) => {
          const active = n.href === '/audiences' ? path === '/audiences' || (path.startsWith('/audiences/') && !path.startsWith('/audiences/new')) : path === n.href || path.startsWith(n.href + '/');
          return (<Link key={n.href} href={n.href} className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors', active ? 'bg-sidebar-accent text-white' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white')}>
            <n.icon className="h-4 w-4 opacity-80" />{n.label}</Link>);
        })}
      </nav>
      <div className="border-t border-sidebar-border px-4 py-3 text-[10px] text-sidebar-foreground/50">{BRAND.name} · database is the source of truth · v0.1</div>
    </aside>
  );
}
