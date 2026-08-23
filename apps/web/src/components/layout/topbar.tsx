'use client';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Moon, Sun, LogOut, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { titleCase } from '@/lib/utils';

export function Topbar({ user, role, orgs, currentOrgId }: { user: { name: string; email: string }; role: string; orgs: Array<{ id: string; name: string }>; currentOrgId: string }) {
  const router = useRouter(); const { theme, setTheme } = useTheme();
  async function logout() { await fetch('/api/v1/auth/logout', { method: 'POST' }); router.push('/login'); router.refresh(); }
  async function switchOrg(id: string) { await fetch('/api/v1/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId: id }) }); router.refresh(); }
  return (
    <header className="flex h-14 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
      <div className="text-xs text-muted-foreground">Connect data → define audience → preview → activate → keep in sync → measure</div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" /><Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="gap-2"><span className="max-w-[160px] truncate">{user.name || user.email}</span><Badge variant="muted">{titleCase(role)}</Badge><ChevronDown className="h-3 w-3" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
            {orgs.length > 1 && (<><DropdownMenuSeparator /><DropdownMenuLabel>Organization</DropdownMenuLabel>{orgs.map((o) => <DropdownMenuItem key={o.id} onClick={() => switchOrg(o.id)}>{o.id === currentOrgId ? '● ' : '○ '}{o.name}</DropdownMenuItem>)}</>)}
            <DropdownMenuSeparator /><DropdownMenuItem onClick={logout}><LogOut className="h-4 w-4" />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
