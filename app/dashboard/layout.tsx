import { Suspense } from 'react';
import Link from 'next/link';
import ThemeToggle from '../../components/ThemeToggle';
import TabNav from '../../components/TabNav';
import UserMenu from '../../components/UserMenu';
import { getViewer } from '../../lib/supabase-server';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();

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
          <TabNav isAdmin={viewer?.isAdmin ?? false} />
        </Suspense>
        <div className="foot">HMIS Performance Dashboard<br />Data refreshed from HMIS</div>
      </aside>
      <div className="mainc">
        <header className="hdr">
          <div>
            <h1>HMIS Performance Dashboard</h1>
            <div className="sub">Miami-Dade County · Continuum of Care</div>
          </div>
          <span className="sp" />
          {viewer && (
            <UserMenu
              label={viewer.displayName || viewer.email || 'Signed in'}
              isAdmin={viewer.isAdmin}
            />
          )}
          <ThemeToggle />
        </header>
        <div className="wrap">{children}</div>
      </div>
    </div>
  );
}
