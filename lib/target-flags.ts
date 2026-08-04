import type { SupabaseClient } from '@supabase/supabase-js';
import { TARGET_METRICS } from './target-metrics';
import type { ProjectMetric } from './types';

/**
 * Off-target evaluation for the Project Performance table (Pillar 3-4
 * follow-on). For every project on the page, resolve its effective targets
 * (project_targets override > type_targets default — the same resolution the
 * project panel uses) and compare against the SAME stored values the page
 * already displays for the selected period. Nothing is recomputed.
 *
 * Only evaluated on the unfiltered view (household/subpopulation = All):
 * targets describe a project's overall performance, and judging an "Adult
 * Only" slice against an overall target would mislead. The partial month
 * simply has no dq/returns rows, so those metrics silently skip there.
 */

export interface TargetMiss {
  key: string;
  label: string;
  unit: string;
  higherBetter: boolean;
  target: number;
  current: number;
}

export async function getTargetFlags(
  sb: SupabaseClient,
  granularity: string,
  period: string,
  household: string,
  subpopulation: string,
  rows: ProjectMetric[],
): Promise<Record<number, TargetMiss[]>> {
  if (household !== 'All' || subpopulation !== 'All' || !rows.length) return {};
  const ids = rows.map((r) => r.project_id);

  const [ptRes, ttRes, projRes, dqRes, retRes, svRes] = await Promise.all([
    sb.from('project_targets').select('project_id, metric, target'),
    sb.from('type_targets').select('project_type, metric, target'),
    sb.from('projects').select('project_id, project_type').in('project_id', ids),
    sb.from('dq_metrics').select('project_id, data')
      .eq('granularity', granularity).eq('period', period).in('project_id', ids),
    sb.from('returns_metrics')
      .select('project_id, total_ph_exits, returns_lt6mo, returns_2yr')
      .eq('granularity', granularity).eq('period', period)
      .eq('household_type', 'All').eq('subpopulation', 'All').in('project_id', ids),
    sb.from('survival_metrics').select('ref_id, median_days').eq('scope', 'project'),
  ]);
  // Any read failing (e.g. type_targets before its SQL ran) → no flags, never an error.
  const pt = (ptRes.data ?? []) as { project_id: number; metric: string; target: number }[];
  const tt = (ttRes.data ?? []) as { project_type: number; metric: string; target: number }[];
  const ptype = new Map(((projRes.data ?? []) as { project_id: number; project_type: number | null }[])
    .map((p) => [Number(p.project_id), p.project_type]));
  const dqScore = new Map(((dqRes.data ?? []) as { project_id: number; data: Record<string, unknown> | null }[])
    .map((d) => [Number(d.project_id),
      typeof d.data?.['DQ_Score'] === 'number' ? (d.data['DQ_Score'] as number) : null]));
  const ret = new Map(((retRes.data ?? []) as {
    project_id: number; total_ph_exits: number | null; returns_lt6mo: number | null; returns_2yr: number | null;
  }[]).map((r) => [Number(r.project_id), r]));
  const median = new Map(((svRes.data ?? []) as { ref_id: number; median_days: number | null }[])
    .map((s) => [Number(s.ref_id), s.median_days]));

  const projT = new Map<number, Map<string, number>>();
  pt.forEach((r) => {
    const m = projT.get(Number(r.project_id)) ?? new Map<string, number>();
    m.set(r.metric, Number(r.target));
    projT.set(Number(r.project_id), m);
  });
  const typeT = new Map<number, Map<string, number>>();
  tt.forEach((r) => {
    const m = typeT.get(Number(r.project_type)) ?? new Map<string, number>();
    m.set(r.metric, Number(r.target));
    typeT.set(Number(r.project_type), m);
  });

  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const out: Record<number, TargetMiss[]> = {};

  for (const row of rows) {
    const id = row.project_id;
    const own = projT.get(id);
    const inherited = ptype.get(id) != null ? typeT.get(ptype.get(id) as number) : undefined;
    if (!own?.size && !inherited?.size) continue;

    const rr = ret.get(id);
    const current: Record<string, number | null> = {
      ph_exit_rate: num(row.ph_exit_rate),
      unsub_rate: num(row.unsub_rate),
      dq_score: dqScore.get(id) ?? null,
      returns_6mo: rr && rr.total_ph_exits ? ((rr.returns_lt6mo ?? 0) / rr.total_ph_exits) * 100 : null,
      returns_2yr: rr && rr.total_ph_exits ? ((rr.returns_2yr ?? 0) / rr.total_ph_exits) * 100 : null,
      avg_los: num(row.avg_los),
      median_days: median.get(id) ?? null,
    };

    const misses: TargetMiss[] = [];
    for (const m of TARGET_METRICS) {
      const target = own?.get(m.key) ?? inherited?.get(m.key);
      const cur = current[m.key];
      if (target == null || cur == null) continue;
      const missed = m.higherBetter ? cur < target : cur > target;
      if (missed) {
        misses.push({ key: m.key, label: m.label, unit: m.unit,
          higherBetter: m.higherBetter, target, current: cur });
      }
    }
    if (misses.length) out[id] = misses;
  }
  return out;
}
