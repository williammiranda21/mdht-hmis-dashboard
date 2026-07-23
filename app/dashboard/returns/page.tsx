import {
  getReturnsPeriods,
  getReturnsMetrics,
  getReturnsByDest,
  getProjectsMap,
} from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import ReturnsView from './ReturnsView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string; hh?: string; sub?: string };

const asGranularity = (g?: string): Granularity =>
  g === 'quarterly' || g === 'fiscal' ? g : 'monthly';

export default async function ReturnsPage({ searchParams }: { searchParams: SearchParams }) {
  const granularity = asGranularity(searchParams.g);
  const household = searchParams.hh || 'All';
  const subpopulation = searchParams.sub || 'All';

  const periods = await getReturnsPeriods(granularity);
  const period = searchParams.p && periods.includes(searchParams.p) ? searchParams.p : periods[0];

  if (!period) {
    return <div className="panel"><div className="empty">No returns data found.</div></div>;
  }

  const [rows, dest, projects] = await Promise.all([
    getReturnsMetrics(granularity, period, household, subpopulation),
    getReturnsByDest(period, household, subpopulation),
    getProjectsMap(),
  ]);

  const merged = rows.map((r) => ({
    project_id: r.project_id,
    name: projects[r.project_id]?.name ?? `Project ${r.project_id}`,
    type_name: projects[r.project_id]?.type_name ?? '',
    project_type: projects[r.project_id]?.project_type ?? null,
    exits: r.total_ph_exits ?? 0,
    lt6: r.returns_lt6mo ?? 0,
    r6: r.returns_6to12mo ?? 0,
    r13: r.returns_13to24mo ?? 0,
    r2: r.returns_2yr ?? 0,
  }));

  // Aggregate by-destination across the visible projects.
  const destAgg: Record<string, { exits: number; returns: number }> = {};
  dest.forEach((d) => {
    Object.entries(d.data || {}).forEach(([code, v]) => {
      const b = (destAgg[code] ??= { exits: 0, returns: 0 });
      b.exits += v?.exits || 0;
      b.returns += v?.returns || 0;
    });
  });

  return (
    <ReturnsView
      periods={periods}
      granularity={granularity}
      period={period}
      household={household}
      subpopulation={subpopulation}
      rows={merged}
      destAgg={destAgg}
    />
  );
}
