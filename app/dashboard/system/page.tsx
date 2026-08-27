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

  // Prior period of the SAME granularity (periods are newest-first) — drives
  // the period-over-period delta on every card (user 2026-08-27: deltas were
  // monthly-only because prev came from the monthly series alone).
  const prevPeriod = periods[periods.indexOf(period) + 1] ?? null;

  const [combos, prevCombos, monthlyAll, sysReturns] = await Promise.all([
    getSystemPeriodCombos(granularity, period),
    prevPeriod ? getSystemPeriodCombos(granularity, prevPeriod) : Promise.resolve([]),
    getSystemMonthlyAllSeries(),
    getSystemReturns(),
  ]);

  return (
    <SpmView
      periods={periods}
      granularity={granularity}
      period={period}
      prevPeriod={prevPeriod}
      household={household}
      combos={combos}
      prevCombos={prevCombos}
      monthlyAll={monthlyAll}
      sysReturns={sysReturns}
    />
  );
}
