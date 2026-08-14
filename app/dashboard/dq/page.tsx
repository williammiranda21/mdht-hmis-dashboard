import { getDqPeriods, getDqMetrics, getProjectsMap } from '../../../lib/queries';
import type { Granularity } from '../../../lib/types';
import { supabaseServer } from '../../../lib/supabase-server';
import { evaForMetric } from '../../../lib/evaChecks';
import { DQ_ELEMENTS } from '../../../lib/dq-elements';
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

  // Eva check counts per project — FOLLOW the selected reporting period
  // (user directive 2026-08-13; recompute_eva v2 emits every complete month,
  // universe = enrollments active in that month, judged on current record
  // state). Quarterly/fiscal views fall back to the latest complete month
  // (rows are monthly-keyed) — DqView labels the fallback.
  const monthly = await getDqPeriods('monthly');
  const evaPeriod = granularity === 'monthly' ? period : (monthly[0] ?? period);
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

  // ── Timeliness + due dates (dq_timeliness / dq_due_dates, 2026-08-14) ────
  // Both degrade to empty when the run-once dq_timeliness.sql hasn't run yet.
  const [tlRes, dueRes] = await Promise.all([
    sb.from('dq_timeliness').select('project_id, median_fix_days, n_fixed, n_open, n_open_30d'),
    sb.from('dq_due_dates').select('project_id, metric, due_date'),
  ]);
  const tl = new Map(((tlRes.data ?? []) as Array<{
    project_id: number; median_fix_days: number | null; n_fixed: number;
    n_open: number; n_open_30d: number;
  }>).map((t) => [Number(t.project_id), t]));

  // Overdue = a due date in the past while the element STILL has records:
  // dq metrics judged by the row's own % field; eva metrics by live eva rows.
  const pctKeyOf = new Map(DQ_ELEMENTS.map((e) => [e.metric, e.pctKey]));
  const evaLeft = new Map<string, number>();
  for (const r of (evaRows ?? []) as Array<{ project_id: number; metric: string; personal_ids: string[] }>) {
    evaLeft.set(`${Number(r.project_id)}|${r.metric}`, (r.personal_ids ?? []).length);
  }
  const rowByProject = new Map(rows.map((r) => [Number(r.project_id), r.data as Record<string, number | null>]));
  const today = new Date().toISOString().slice(0, 10);
  const overdue: Record<number, string[]> = {};
  for (const dRow of (dueRes.data ?? []) as Array<{ project_id: number; metric: string; due_date: string }>) {
    if (dRow.due_date >= today) continue;
    const pid = Number(dRow.project_id);
    let remains = false;
    const pctKey = pctKeyOf.get(dRow.metric);
    if (pctKey) remains = ((rowByProject.get(pid)?.[pctKey] ?? 0) as number) > 0;
    else if (dRow.metric.startsWith('eva:')) remains = (evaLeft.get(`${pid}|${dRow.metric}`) ?? 0) > 0;
    if (remains) (overdue[pid] ??= []).push(dRow.metric);
  }

  const merged = rows.map((r) => ({
    project_id: r.project_id,
    name: projects[r.project_id]?.name ?? `Project ${r.project_id}`,
    type_name: projects[r.project_id]?.type_name ?? '',
    project_type: projects[r.project_id]?.project_type ?? null,
    // Timeliness rides inside `d` so DqView's generic column sort covers it.
    d: {
      ...r.data,
      DQ_FixMedian: tl.get(Number(r.project_id))?.median_fix_days ?? null,
      DQ_FixN: tl.get(Number(r.project_id))?.n_fixed ?? null,
      DQ_Open30: tl.get(Number(r.project_id))?.n_open_30d ?? null,
    },
  }));

  // Deep-link (?focus=<project_id>) — e.g. from the Deep Dive DQ summary card:
  // opens that project's fix-list as soon as the page mounts.
  const focusProject = Number.isFinite(Number(searchParams.focus)) && searchParams.focus
    ? Number(searchParams.focus) : null;

  return <DqView periods={periods} granularity={granularity} period={period} rows={merged}
    evaCounts={evaCounts} evaPeriod={evaPeriod} focusProject={focusProject} overdue={overdue} />;
}
