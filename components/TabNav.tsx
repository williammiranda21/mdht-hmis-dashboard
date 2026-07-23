'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const TABS = [
  { href: '/dashboard', label: 'Project Performance', icon: 'grid' },
  { href: '/dashboard/rankings', label: 'Rankings', icon: 'trophy' },
  { href: '/dashboard/returns', label: 'Returns', icon: 'return' },
  { href: '/dashboard/system', label: 'System Performance', icon: 'globe' },
  { href: '/dashboard/dq', label: 'Data Quality', icon: 'search' },
  { href: '/dashboard/utilization', label: 'Unit Utilization', icon: 'bed' },
  { href: '/dashboard/bnl', label: 'By-Name List', icon: 'lock' },
  { href: '/dashboard/deep-dive', label: 'Deep Dive', icon: 'search' },
] as const;

/** Shown only to admins. */
const ADMIN_TAB = { href: '/dashboard/admin', label: 'Users', icon: 'users' } as const;

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
};

export default function TabNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  const suffix = qs ? `?${qs}` : '';
  const tabs = isAdmin ? [...TABS, ADMIN_TAB] : TABS;

  return (
    <nav className="tabnav">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={`${t.href}${suffix}`} className={`tab${active ? ' on' : ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              {ICONS[t.icon]}
            </svg>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
