'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Header h1 names the page you're on (user ask 2026-09-15) instead of
// repeating the app name on every route. Labels mirror TabNav. Ordered
// specific → general: find() takes the first prefix hit, so deeper routes
// must sit above their parents (/dashboard last — it prefixes everything).
const TITLES: [string, string][] = [
  ['/dashboard/returns', 'Returns'],
  ['/dashboard/system', 'System Performance'],
  ['/dashboard/dq/users', 'Data Quality · Error rates by user'],
  ['/dashboard/dq', 'Data Quality'],
  ['/dashboard/utilization', 'Unit Utilization'],
  ['/dashboard/bnl', 'By-Name List'],
  ['/dashboard/youth-intake', 'Youth Intake'],
  ['/dashboard/helpline/report', 'Helpline · Monthly report'],
  ['/dashboard/helpline', 'Helpline'],
  ['/dashboard/rankings', 'Rankings'],
  ['/dashboard/deep-dive', 'Deep Dive'],
  ['/dashboard/analytics', 'Analytics'],
  ['/dashboard/glossary', 'Glossary'],
  ['/dashboard/admin/cohorts', 'Cohorts'],
  ['/dashboard/admin/targets', 'Targets'],
  ['/dashboard/admin', 'Users'],
  ['/dashboard/account', 'My account'],
  ['/dashboard/announcements', 'Announcements'],
  ['/dashboard', 'Project Performance'],
];

const APP = 'HMIS Performance Dashboard';

export default function HeaderTitle() {
  const pathname = usePathname() || '';
  const hit = TITLES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  const title = hit ? hit[1] : APP;
  const tabTitle = hit ? `${hit[1]} · ${APP}` : APP;
  // Keep the browser tab in sync with the page (soft navigations don't
  // re-run server metadata, so set it client-side).
  useEffect(() => { document.title = tabTitle; }, [tabTitle]);
  return <h1>{title}</h1>;
}
