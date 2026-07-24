import { getPeriods, getProjectMetrics } from '../../../lib/queries';
import { getViewer } from '../../../lib/supabase-server';
import type { Granularity } from '../../../lib/types';
import RankingsView from './RankingsView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string; hh?: string; sub?: string };

const asGranularity = (g?: string): Granularity =>
  g === 'quarterly' || g === 'fiscal' ? g : 'monthly';

export default async function RankingsPage({ searchParams }: { searchParams: SearchParams }) {
  // Admin-only. Hiding the tab isn't security — a provider could still type the
  // URL — so gate the page itself. Rankings puts every agency's numbers side by
  // side; the user wants that kept to Homeless Trust admins so providers aren't
  // shown a leaderboard of their peers.
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects
  if (!viewer.isAdmin) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Rankings are limited to Homeless Trust administrators.
          </div>
        </div>
      </div>
    );
  }

  const granularity = asGranularity(searchParams.g);
  const household = searchParams.hh || 'All';
  const subpopulation = searchParams.sub || 'All';

  const periods = await getPeriods(granularity);
  const period = searchParams.p && periods.includes(searchParams.p) ? searchParams.p : periods[0];

  if (!period) {
    return <div className="panel"><div className="empty">No data found.</div></div>;
  }

  const rows = await getProjectMetrics(granularity, period, household, subpopulation);

  return (
    <RankingsView
      rows={rows}
      periods={periods}
      granularity={granularity}
      period={period}
      household={household}
      subpopulation={subpopulation}
    />
  );
}
