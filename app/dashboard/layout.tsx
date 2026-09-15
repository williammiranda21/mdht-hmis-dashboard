import { Suspense } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ThemeToggle from '../../components/ThemeToggle';
import TabNav from '../../components/TabNav';
import UserMenu from '../../components/UserMenu';
import IdleLogout from '../../components/IdleLogout';
import AnnouncementBar, { type Announcement } from '../../components/AnnouncementBar';
import PolicyAttestation from '../../components/PolicyAttestation';
import { getViewer, supabaseServer } from '../../lib/supabase-server';

/** '2026-08-10' → '8/10/2026' without a Date parse (timezone-safe). */
function fmtAsOf(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${+m[2]}/${+m[3]}/${m[1]}` : s;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();

  // Data cutoff (Export.csv ExportEndDate, loaded into meta.export_end) —
  // shown on every page so nobody mistakes the dashboard for live HMIS.
  let exportEnd: string | null = null;
  // Does a NON-admin have any per-cohort grant? Drives the Cohorts nav link
  // (cohort_access RLS lets a user read only their own rows; a missing table
  // — cohort_tasks.sql not run — just returns an error → false).
  let cohortAccess = false;
  // Active admin broadcast (announcements table; comments.sql not run → null).
  let announcement: Announcement | null = null;
  // COHORT-ONLY role (user directive 2026-09-15): an approved non-admin whose
  // ONLY grant is cohort_access — no projects, no BNL/YC/Helpline — sees the
  // Cohorts page (plus My account and Announcements) and nothing else. The
  // role is DERIVED, not a flag: granting a project or any other access later
  // un-scopes them automatically.
  let cohortOnly = false;
  if (viewer?.isApproved) {
    const sb = supabaseServer();
    const today = new Date().toISOString().slice(0, 10);
    const [metaRes, accessRes, annRes, projRes] = await Promise.all([
      sb.from('meta').select('value').eq('key', 'export_end').maybeSingle(),
      viewer.isAdmin
        ? Promise.resolve({ data: null })
        : sb.from('cohort_access').select('cohort_id').limit(1),
      sb.from('announcements')
        .select('id, body, details, kind, created_at, expires_on')
        .or(`expires_on.is.null,expires_on.gte.${today}`)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle(),
      viewer.isAdmin
        ? Promise.resolve({ data: null })
        : sb.from('user_projects').select('project_id').limit(1),
    ]);
    exportEnd = (metaRes.data?.value as string | null) ?? null;
    cohortAccess = ((accessRes.data as unknown[] | null)?.length ?? 0) > 0;
    announcement = (annRes && 'data' in annRes ? annRes.data : null) as Announcement | null;
    const hasProjects = ((projRes.data as unknown[] | null)?.length ?? 0) > 0;
    cohortOnly = !viewer.isAdmin && cohortAccess && !hasProjects
      && !viewer.canSeeBnl && !viewer.canSeeYc && !viewer.canSeeHelpline;
    if (cohortOnly) {
      const path = headers().get('x-pathname') ?? '';
      const allowed = ['/dashboard/admin/cohorts', '/dashboard/account', '/dashboard/announcements']
        .some((p) => path === p || path.startsWith(`${p}/`));
      if (!allowed) redirect('/dashboard/admin/cohorts');
    }
  }

  // Signed in but not approved yet (or switched off): show the status screen
  // instead of the dashboard. RLS would return nothing anyway — this just makes
  // the reason obvious rather than rendering a wall of empty tables.
  if (viewer && !viewer.isApproved) {
    return (
      <main className="loginwrap">
        <div className="logincard">
          <div className="loginbrand">
            <span className="mark">HT</span>
            <span>
              <span className="nm">Miami-Dade County Homeless Trust</span>
              <span className="sub">FL-600 System Dashboard</span>
            </span>
          </div>
          {viewer.status === 'disabled' ? (
            <>
              <h1>Access disabled</h1>
              <p className="loginhint">
                This account has been turned off. Contact a Homeless Trust administrator if you
                think that’s a mistake.
              </p>
            </>
          ) : (
            <>
              <h1>Waiting for approval</h1>
              <p className="loginhint">
                Thanks {viewer.displayName || 'for signing up'} — your account exists but an
                administrator still needs to approve it and choose which projects you can see.
                You’ll get access as soon as that’s done.
              </p>
            </>
          )}
          <div className="lmeta">
            Signed in as {viewer.email}
            {viewer.agency ? ` · ${viewer.agency}` : ''}
          </div>
          <div style={{ marginTop: 18 }}>
            <UserMenu
              label={viewer.displayName || viewer.email || 'Signed in'}
              isAdmin={false}
              showAccountLink={false}
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidenav">
        <Link href="/dashboard" className="brand" aria-label="Dashboard home">
          <span className="mark">HT</span>
          <span>
            <span className="nm" style={{ display: 'block' }}>Miami-Dade County Homeless Trust</span>
            <span className="sub">FL-600 System Dashboard</span>
          </span>
        </Link>
        <div className="nav-label">Menu</div>
        <Suspense fallback={<nav className="tabnav" />}>
          <TabNav isAdmin={viewer?.isAdmin ?? false} cohortAccess={cohortAccess}
            cohortOnly={cohortOnly}
            ycAccess={viewer?.canSeeYc ?? false} hlAccess={viewer?.canSeeHelpline ?? false} />
        </Suspense>
        <div className="foot">HMIS Performance Dashboard<br />Data refreshed from HMIS</div>
      </aside>
      <div className="mainc">
        <header className="hdr">
          <div>
            <h1>HMIS Performance Dashboard</h1>
            <div className="sub">
              Miami-Dade County · Continuum of Care
              {exportEnd && (
                <span title="End date of the HMIS export behind every number on this dashboard">
                  {' · '}Data as of <b style={{ color: 'var(--strong)' }}>{fmtAsOf(exportEnd)}</b>
                </span>
              )}
            </div>
          </div>
          <span className="sp" />
          <Link href="/dashboard/announcements" title="Announcements — notices and dashboard updates"
            style={{ fontSize: 16, textDecoration: 'none', marginRight: 10, lineHeight: 1 }}>
            📣
          </Link>
          {viewer && (
            <UserMenu
              label={viewer.displayName || viewer.email || 'Signed in'}
              isAdmin={viewer.isAdmin}
            />
          )}
          <ThemeToggle />
        </header>
        <div className="wrap">
          {/* Annual P&P acknowledgment (gap #6): approved users must (re)accept
              every 365 days — mirrors the Trust's paper User's Acknowledgement
              Form. Blocks everything until agreed; sign-out is the only exit. */}
          {viewer?.isApproved && (() => {
            const at = viewer.policiesAttestedAt ? new Date(viewer.policiesAttestedAt).getTime() : null;
            const stale = at == null || Number.isNaN(at)
              || (Date.now() - at) > 365 * 24 * 60 * 60 * 1000;
            return stale
              ? <PolicyAttestation renewal={at != null && !Number.isNaN(at)} email={viewer.email} />
              : null;
          })()}
          <AnnouncementBar initial={announcement} isAdmin={viewer?.isAdmin ?? false} />
          {children}
        </div>
      </div>
      <IdleLogout />
    </div>
  );
}
