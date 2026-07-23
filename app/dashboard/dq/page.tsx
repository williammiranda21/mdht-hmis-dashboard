import { getDqPeriods, getDqMetrics, getProjectsMap } from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import DqView from './DqView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string };

const asGranularity = (g?: string): Granularity =>
  g === 'quarterly' || g === 'fiscal' ? g : 'monthly';

export default async function DataQualityPage({ searchParams }: { searchParams: SearchParams }) {
  const granularity = asGranularity(searchParams.g);
  const periods = await getDqPeriods(granularity);
  const period = searchParams.p && periods.includes(searchParams.p) ? searchParams.p : periods[0];

  if (!period) {
    return <div className="panel"><div className="empty">No data quality records found.</div></div>;
  }

  const [rows, projects] = await Promise.all([
    getDqMetrics(granularity, period),
    getProjectsMap(),
  ]);

  const merged = rows.map((r) => ({
    project_id: r.project_id,
    name: projects[r.project_id]?.name ?? `Project ${r.project_id}`,
    type_name: projects[r.project_id]?.type_name ?? '',
    project_type: projects[r.project_id]?.project_type ?? null,
    d: r.data,
  }));

  return <DqView periods={periods} granularity={granularity} period={period} rows={merged} />;
}
