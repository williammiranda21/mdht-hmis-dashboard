import { getDqPeriods, getDqMetrics, getProjectsMap } from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import { supabaseServer } from '../../../lib/supabase-server';
import { evaForMetric } from '../../../lib/evaChecks';
import DqView from './DqView';

export const dynamic = 'force-dynamic';

type SearchParams = { g?: string; p?: string; focus?: string };

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

  // Eva check counts per project — snapshot keyed to the latest COMPLETE month
  // (independent of the selected period/granularity). Unique clients per
  // severity; rendered as the "Eva issues" column in DqView.
  const monthly = await getDqPeriods('monthly');
  const evaPeriod = monthly[0] ?? period;   // getDqPeriods returns newest first
  const sb = supabaseServer();
  const { data: evaRows } = await sb.from('drill_clients')
    .select('project_id, metric, personal_ids')
    .eq('period', evaPeriod)
    .like('metric', 'eva:%');
  // Keyed project → check CATEGORY → severity → unique clients, so the view can
  // place income checks inside the Q6c column and give Household/Dates/Duplicates
  // their own compact columns.
  const sets: Record<number, Record<string, { hp: Set<string>; error: Set<string>; warning: Set<string> }>> = {};
  for (const r of (evaRows ?? []) as Array<{ project_id: number; metric: string; personal_ids: string[] }>) {
    const check = evaForMetric(r.metric);
    if (!check) continue;
    const pid = Number(r.project_id);
    sets[pid] ??= {};
    sets[pid][check.category] ??= { hp: new Set(), error: new Set(), warning: new Set() };
    for (const c of r.personal_ids ?? []) sets[pid][check.category][check.severity].add(c);
  }
  const evaCounts: Record<number, Record<string, { hp: number; error: number; warning: number }>> = {};
  for (const [pid, cats] of Object.entries(sets)) {
    evaCounts[Number(pid)] = Object.fromEntries(Object.entries(cats).map(([cat, s]) =>
      [cat, { hp: s.hp.size, error: s.error.size, warning: s.warning.size }]));
  }

  const merged = rows.map((r) => ({
    project_id: r.project_id,
    name: projects[r.project_id]?.name ?? `Project ${r.project_id}`,
    type_name: projects[r.project_id]?.type_name ?? '',
    project_type: projects[r.project_id]?.project_type ?? null,
    d: r.data,
  }));

  // Deep-link (?focus=<project_id>) — e.g. from the Deep Dive DQ summary card:
  // opens that project's fix-list as soon as the page mounts.
  const focusProject = Number.isFinite(Number(searchParams.focus)) && searchParams.focus
    ? Number(searchParams.focus) : null;

  return <DqView periods={periods} granularity={granularity} period={period} rows={merged}
    evaCounts={evaCounts} focusProject={focusProject} />;
}
