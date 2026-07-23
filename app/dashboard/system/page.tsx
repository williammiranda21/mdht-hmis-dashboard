import {
  getSystemPeriods,
  getSystemPeriodCombos,
  getSystemMonthlyAllSeries,
  getSystemReturns,
} from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import SpmView from './SpmView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string; hh?: string };

const asGranularity = (g?: string): Granularity =>
  g === 'quarterly' || g === 'fiscal' ? g : 'monthly';

export default async function SystemPerformancePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const granularity = asGranularity(searchParams.g);
  const household = searchParams.hh || 'All';

  const periods = await getSystemPeriods(granularity);
  const period = searchParams.p && periods.includes(searchParams.p) ? searchParams.p : periods[0];

  if (!period) {
    return <div className="panel"><div className="empty">No system performance data found.</div></div>;
  }

  const [combos, monthlyAll, sysReturns] = await Promise.all([
    getSystemPeriodCombos(granularity, period),
    getSystemMonthlyAllSeries(),
    getSystemReturns(),
  ]);

  return (
    <SpmView
      periods={periods}
      granularity={granularity}
      period={period}
      household={household}
      combos={combos}
      monthlyAll={monthlyAll}
      sysReturns={sysReturns}
    />
  );
}
