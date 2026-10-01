import Link from 'next/link';
import ThemeToggle from '../../components/ThemeToggle';
import UserMenu from '../../components/UserMenu';
import IdleLogout from '../../components/IdleLogout';
import PolicyAttestation from '../../components/PolicyAttestation';
import { getViewer } from '../../lib/supabase-server';
import HelplineNav from './HelplineNav';

/**
 * Standalone Helpline app (user 2026-10-01: "like localhost:3011/helpline").
 *
 * Its own home — no dashboard sidebar — for call intake, triage, the team
 * board, the monthly report and dispatch sheets. Permissions are UNCHANGED:
 * each page keeps its own canSeeHelpline gate, and helpline staff keep
 * whatever dashboard access their grants already give them (Dashboard link).
 * The same safeguards as the dashboard apply here: 60-minute idle sign-out
 * and the annual HMIS Policies & Procedures acknowledgment. The header is a
 * <header className="hdr">, which the dispatch sheet's print CSS hides.
 */
export default async function HelplineLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();

  if (viewer && !viewer.isApproved) {
    return (
      <main className="loginwrap">
        <div className="logincard">
          <h1>{viewer.status === 'disabled' ? 'Access disabled' : 'Waiting for approval'}</h1>
          <p className="loginhint">
            {viewer.status === 'disabled'
              ? 'This account has been turned off. Contact a Homeless Trust administrator if you think that’s a mistake.'
              : 'Your account exists but an administrator still needs to approve it.'}
          </p>
          <div style={{ marginTop: 18 }}>
            <UserMenu label={viewer.displayName || viewer.email || 'Signed in'} isAdmin={false} showAccountLink={false} />
          </div>
        </div>
      </main>
    );
  }

  const stale = (() => {
    if (!viewer?.isApproved) return false;
    const at = viewer.policiesAttestedAt ? new Date(viewer.policiesAttestedAt).getTime() : null;
    return at == null || Number.isNaN(at) || Date.now() - at > 365 * 24 * 60 * 60 * 1000;
  })();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header className="hdr" style={{ flexWrap: 'wrap', height: 'auto', minHeight: 56, padding: '8px 24px', rowGap: 8 }}>
        <Link href="/helpline" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}
          aria-label="Helpline home">
          <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--primary)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13 }}>HT</span>
          <span>
            <h1 style={{ margin: 0 }}>Helpline</h1>
            <div className="sub">Miami-Dade County Homeless Trust</div>
          </span>
        </Link>
        <span style={{ width: 10 }} />
        <HelplineNav />
        <span className="sp" />
        <Link href="/field" className="tbtn" title="Mobile app for outreach teams in the field">Field app</Link>
        <Link href="/dashboard" className="tbtn" title="The HMIS Performance Dashboard (your usual access)">Dashboard →</Link>
        {viewer && (
          <UserMenu label={viewer.displayName || viewer.email || 'Signed in'} isAdmin={viewer.isAdmin} />
        )}
        <ThemeToggle />
      </header>
      {/* wider than the dashboard's 1340px (user 2026-10-01): the board's case
          rows and the map use the room; capped so rows stay easy to follow on
          very wide monitors. The New call form keeps its own 720px column. */}
      <div className="wrap" style={{ maxWidth: 1760 }}>
        {stale && viewer && (
          <PolicyAttestation renewal={Boolean(viewer.policiesAttestedAt)} email={viewer.email} />
        )}
        {children}
      </div>
      <IdleLogout />
    </div>
  );
}
