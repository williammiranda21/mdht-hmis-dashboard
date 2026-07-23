import { getUtilPeriods, getUtilization } from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import UtilizationView from './UtilizationView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string };

const asGranularity = (g?: string): Granularity =>
  g === 'quarterly' || g === 'fiscal' ? g : 'monthly';

export default async function UtilizationPage({ searchParams }: { searchParams: SearchParams }) {
  const granularity = asGranularity(searchParams.g);
  const periods = await getUtilPeriods(granularity);
  const period = searchParams.p && periods.includes(searchParams.p) ? searchParams.p : periods[0];

  if (!period) {
    return <div className="panel"><div className="empty">No utilization data found.</div></div>;
  }

  const util = await getUtilization(period);
  if (!util) {
    return <div className="panel"><div className="empty">No utilization data for this period.</div></div>;
  }

  return <UtilizationView periods={periods} granularity={granularity} period={period} util={util} />;
}
