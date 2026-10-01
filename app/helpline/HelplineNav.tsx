'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Section links for the standalone Helpline app (user 2026-10-01). */
const LINKS: [string, string][] = [
  ['/helpline', 'Triage'],
  ['/helpline/new', 'New call'],
  ['/helpline/report', 'Monthly report'],
];

export default function HelplineNav() {
  const path = usePathname() ?? '';
  return (
    <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} aria-label="Helpline sections">
      {LINKS.map(([href, label]) => {
        const on = href === '/helpline' ? path === '/helpline' : path.startsWith(href);
        return (
          <Link key={href} href={href} className={`tbtn${on ? ' tbtn-sel' : ''}`}
            aria-current={on ? 'page' : undefined}>{label}</Link>
        );
      })}
    </nav>
  );
}
