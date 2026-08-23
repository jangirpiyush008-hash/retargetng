'use client';
import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BRAND } from '@/lib/brand';

export function LoginForm() {
  const router = useRouter(); const sp = useSearchParams();
  const [email, setEmail] = useState('admin@demo.aap'); const [password, setPassword] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const r = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    setBusy(false);
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j?.error?.message ?? 'Login failed'); return; }
    router.push(sp.get('next') || '/dashboard'); router.refresh();
  }
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2 text-white"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary"><Radio className="h-4 w-4" /></div><span className="font-semibold">{BRAND.name}</span></div>
        <div className="max-w-md space-y-4">
          <h1 className="text-3xl font-semibold leading-tight text-white">{BRAND.headline}</h1>
          <p className="text-sm text-sidebar-foreground/70">{BRAND.blurb}</p>
        </div>
        <div className="text-xs text-sidebar-foreground/50">{BRAND.name} · your data stays in your database · destinations receive hashed identifiers only</div>
      </div>
      <div className="flex items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div><h2 className="text-xl font-semibold">Sign in to {BRAND.name}</h2><p className="text-sm text-muted-foreground">Use your {BRAND.name} account. Accounts are created by your administrator (Settings → Members) or by the demo seed.</p></div>
          <div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></div>
          <div className="space-y-1.5"><Label htmlFor="password">Password</Label><Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
          {err && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          <div className="rounded-md bg-muted p-3 text-[11px] text-muted-foreground"><div className="font-medium text-foreground">Demo accounts (exist only after the demo seed has run)</div><div>admin@demo.aap / Admin12345!</div><div>marketer@demo.aap / Marketer12345!</div><div>analyst@demo.aap / Analyst12345!</div><div>viewer@demo.aap / Viewer12345!</div></div>
        </form>
      </div>
    </div>
  );
}
