import { requireSession } from '@/server/session';
import { ctx } from '@/server/context';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';

export const dynamic = 'force-dynamic';
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  const org = s.organizations.find((o) => o.id === s.principal.organizationId)!;
  const mode = ctx().registry.currentMode;
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar orgName={org?.name ?? 'Organization'} mode={mode} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={{ name: s.userName, email: s.principal.label }} role={s.principal.role} orgs={s.organizations} currentOrgId={s.principal.organizationId} />
        <main className="flex-1 overflow-y-auto"><div className="mx-auto max-w-[1400px] px-6 py-6">{children}</div></main>
      </div>
    </div>
  );
}
