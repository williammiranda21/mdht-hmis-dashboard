'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

// `adminOnly` tabs are hidden from providers/approved non-admins entirely (the
// pages themselves also re-check — hiding the tab is not the security boundary).
// Rankings sits below the By-Name List and is admin-only: it lines every agency's
// numbers up against each other, which the user doesn't want providers to see.
const TABS = [
  { href: '/dashboard', label: 'Project Performance', icon: 'grid' },
  { href: '/dashboard/returns', label: 'Returns', icon: 'return' },
  { href: '/dashboard/system', label: 'System Performance', icon: 'globe' },
  { href: '/dashboard/forecast', label: 'Forecast', icon: 'trend' },
  { href: '/dashboard/dq', label: 'Data Quality', icon: 'search' },
  { href: '/dashboard/utilization', label: 'Unit Utilization', icon: 'bed' },
  { href: '/dashboard/bnl', label: 'By-Name List', icon: 'lock' },
  // Youth Connect: admins + yc_access grantees (Educate Tomorrow). Hidden from
  // everyone else — the page re-checks, hiding the tab is not the boundary.
  { href: '/dashboard/youth-intake', label: 'Youth Intake', icon: 'sprout', ycOnly: true, dev: true },
  // Helpline Triage: admins + helpline_access grantees (operators/Trust staff).
  { href: '/dashboard/helpline', label: 'Helpline', icon: 'phone', hlOnly: true, dev: true },
  { href: '/dashboard/rankings', label: 'Rankings', icon: 'trophy', adminOnly: true },
  { href: '/dashboard/deep-dive', label: 'Deep Dive', icon: 'search' },
  { href: '/dashboard/glossary', label: 'Glossary', icon: 'book' },
  { href: '/dashboard/admin', label: 'Users', icon: 'users', adminOnly: true },
  { href: '/dashboard/admin/cohorts', label: 'Cohorts', icon: 'cohort', adminOnly: true },
  { href: '/dashboard/admin/targets', label: 'Targets', icon: 'target', adminOnly: true },
] as const;

const ICONS: Record<string, JSX.Element> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  trophy: (
    <>
      <path d="M6 9a6 6 0 0 0 12 0V3H6z" />
      <path d="M6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 21h6M12 15v6" />
    </>
  ),
  return: <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" />
    </>
  ),
  trend: (
    <>
      <path d="M3 17l6-6 4 4 8-8" /><path d="M21 7h-5M21 7v5" />
    </>
  ),
  bed: (
    <>
      <path d="M2 17V8M2 12h18a2 2 0 0 1 2 2v3M2 17h20" /><circle cx="7" cy="11" r="1.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" />
    </>
  ),
  phone: (
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.13.96.36 1.9.7 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.25a2 2 0 0 1 2.1-.45c.9.34 1.84.57 2.8.7A2 2 0 0 1 22 16.9z" />
  ),
  sprout: (
    <>
      <path d="M12 21v-8" />
      <path d="M12 13c0-4-3-7-8-7 0 5 3 8 8 7zM12 11c0-3.5 2.5-6 8-6 0 4.5-2.5 7-8 6" />
    </>
  ),
  cohort: (
    <>
      <circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" />
      <path d="M2 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M14 14h3a5 5 0 0 1 5 5v1" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </>
  ),
};

type Tab = (typeof TABS)[number];
const isAdminTab = (t: Tab): boolean => 'adminOnly' in t && t.adminOnly === true;
const isYcTab = (t: Tab): boolean => 'ycOnly' in t && t.ycOnly === true;
const isHlTab = (t: Tab): boolean => 'hlOnly' in t && t.hlOnly === true;
// `dev` tabs carry an "under development" note so pilot users know the page
// is still being shaped (user ask 2026-08-20).
const isDevTab = (t: Tab): boolean => 'dev' in t && t.dev === true;

export default function TabNav({ isAdmin = false, cohortAccess = false, ycAccess = false, hlAccess = false }:
    { isAdmin?: boolean; cohortAccess?: boolean; ycAccess?: boolean; hlAccess?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  const suffix = qs ? `?${qs}` : '';

  const renderTab = (t: Tab) => {
    const active = pathname === t.href;
    return (
      <Link key={t.href} href={`${t.href}${suffix}`} className={`tab${active ? ' on' : ''}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          {ICONS[t.icon]}
        </svg>
        {isDevTab(t)
          ? <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              {t.label}
              <span className="nav-dev">under development</span>
            </span>
          : t.label}
      </Link>
    );
  };

  // A non-admin who was granted specific cohorts (cohort_access) gets the
  // Cohorts tab in the main list — the page itself is RLS-scoped to their
  // grants. Admins keep it in the Admin section as before.
  const regular = TABS.filter((t) => (!isAdminTab(t)
    || (!isAdmin && cohortAccess && t.href === '/dashboard/admin/cohorts'))
    && (!isYcTab(t) || isAdmin || ycAccess)
    && (!isHlTab(t) || isAdmin || hlAccess));
  const admin = TABS.filter(isAdminTab);

  return (
    <nav className="tabnav">
      {regular.map(renderTab)}
      {/* Admin section — the leaderboard-style Rankings and the user console live
          here, apart from the tools every provider uses. Non-admins never see it. */}
      {isAdmin && admin.length > 0 && (
        <>
          <div className="nav-label nav-sep">Admin</div>
          {admin.map(renderTab)}
        </>
      )}
    </nav>
  );
}
