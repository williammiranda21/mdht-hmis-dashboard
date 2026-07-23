import { getPeriods, getProjectMetrics } from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import RankingsView from './RankingsView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string; hh?: string; sub?: string };

const asGranularity = (g?: string): Granularity =>
  g === 'quarterly' || g === 'fiscal' ? g : 'monthly';

export default async function RankingsPage({ searchParams }: { searchParams: SearchParams }) {
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
