import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Since-last-month digest (Pillar 3) — "what changed" for a set of projects.
 *
 * Compares the LAST TWO COMPLETE months (from meta.dq_periods — the partial
 * in-progress month is deliberately not headlined; it is too noisy to narrate).
 * Everything is a diff of stored rows:
 *   • project_metrics  — clients served, PH exit rate, avg LOS
 *   • dq_metrics       — DQ score
 *   • drill_clients dq:* — per-element offending-client sets, diffed to
 *     "new errors" vs "cleared" at the CLIENT level (unique pids), which is what
 *     makes the digest actionable rather than just "numbers moved".
 * RLS: dq:* reads are agency-scoped (`scoped read drill`); aggregates are
 * approved-read. Same session client as every other route.
 */

const DQ_SHORT: Record<string, string> = {
  'dq:dest': 'exit destination', 'dq:movein': 'move-in date', 'dq:income': 'income at entry',
  'dq:annual': 'annual assessment', 'dq:name': 'name', 'dq:ssn': 'SSN', 'dq:dob': 'DOB',
  'dq:race': 'race/ethnicity', 'dq:sex': 'sex',
};

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const ids = (sp.get('projects') ?? '')
    .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  if (!ids.length) return NextResponse.json({ error: 'projects required' }, { status: 400 });

  const sb = supabaseServer();

  // Last two COMPLETE months. dq_periods stops at the last complete month by
  // construction (see the ETL) — do not use meta.periods here, it includes the
  // partial month.
  const { data: dqp } = await sb.from('meta').select('value').eq('key', 'dq_periods').maybeSingle();
  const monthly: string[] = ((dqp?.value as { monthly?: string[] } | null)?.monthly ?? []);
  if (monthly.length < 2) return NextResponse.json({ error: 'not enough history' }, { status: 404 });
  const cur = monthly[monthly.length - 1];
  const prev = monthly[monthly.length - 2];

  const [pmRes, dqRes, drillRes, projRes] = await Promise.all([
    sb.from('project_metrics')
      .select('project_id, period, clients_served, ph_exit_rate, avg_los')
      .in('period', [cur, prev]).eq('granularity', 'monthly')
      .eq('household_type', 'All').eq('subpopulation', 'All')
      .in('project_id', ids),
    sb.from('dq_metrics')
      .select('project_id, period, data')
      .in('period', [cur, prev]).eq('granularity', 'monthly')
      .in('project_id', ids),
    // Paged: 9 dq elements × 2 months × N projects can pass PostgREST's
    // 1000-row response cap on a large selection ("Select all shown").
    (async () => {
      const out: unknown[] = [];
      for (let from = 0; ; from += 1000) {
        const r = await sb.from('drill_clients')
          .select('project_id, period, metric, personal_ids')
          .in('period', [cur, prev]).in('project_id', ids)
          .like('metric', 'dq:%')
          .order('project_id').order('metric')
          .range(from, from + 999);
        if (r.error) return r;
        out.push(...(r.data ?? []));
        if ((r.data ?? []).length < 1000) break;
      }
      return { data: out, error: null };
    })(),
    sb.from('projects').select('project_id, name, type_name').in('project_id', ids),
  ]);
  for (const r of [pmRes, dqRes, drillRes, projRes]) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  }

  type PM = { project_id: number; period: string; clients_served: number | null; ph_exit_rate: number | null; avg_los: number | null };
  const pm = (pmRes.data ?? []) as PM[];
  const dq = (dqRes.data ?? []) as Array<{ project_id: number; period: string; data: Record<string, unknown> | null }>;
  const drill = (drillRes.data ?? []) as Array<{ project_id: number; period: string; metric: string; personal_ids: string[] | null }>;
  const projInfo = new Map((projRes.data ?? []).map(
    (p: { project_id: number; name: string | null; type_name: string | null }) =>
      [Number(p.project_id), { name: p.name ?? `Project ${p.project_id}`, type: p.type_name }]));

  const pick = <T extends { project_id: number; period: string }>(rows: T[], id: number, period: string): T | undefined =>
    rows.find((r) => Number(r.project_id) === id && r.period === period);

  const rows = ids.map((id) => {
    const a = pick(pm, id, prev), b = pick(pm, id, cur);
    const dqa = pick(dq, id, prev), dqb = pick(dq, id, cur);
    const score = (r?: { data: Record<string, unknown> | null }) =>
      typeof r?.data?.['DQ_Score'] === 'number' ? (r.data['DQ_Score'] as number) : null;

    // dq:* client-set diffs, per element then totalled. A client counts once per
    // element (matches the fix-list's own dedup).
    let errNew = 0, errCleared = 0;
    let topEl: { label: string; n: number } | null = null;
    const metrics = new Set(drill.filter((r) => Number(r.project_id) === id).map((r) => r.metric));
    for (const m of metrics) {
      const before = new Set(pick(drill.filter((r) => r.metric === m), id, prev)?.personal_ids ?? []);
      const after = new Set(pick(drill.filter((r) => r.metric === m), id, cur)?.personal_ids ?? []);
      let added = 0;
      for (const p of after) if (!before.has(p)) added++;
      let removed = 0;
      for (const p of before) if (!after.has(p)) removed++;
      errNew += added; errCleared += removed;
      if (added > 0 && (!topEl || added > topEl.n)) topEl = { label: DQ_SHORT[m] ?? m, n: added };
    }

    return {
      project_id: id,
      name: projInfo.get(id)?.name ?? `Project ${id}`,
      type: projInfo.get(id)?.type ?? null,
      clients: { prev: a?.clients_served ?? null, cur: b?.clients_served ?? null },
      ph_rate: { prev: a?.ph_exit_rate ?? null, cur: b?.ph_exit_rate ?? null },
      avg_los: { prev: a?.avg_los ?? null, cur: b?.avg_los ?? null },
      dq_score: { prev: score(dqa), cur: score(dqb) },
      err_new: errNew, err_cleared: errCleared,
      top_new_element: topEl,
      // active either month — projects dark in both are dropped client-side
      active: !!(a || b || errNew || errCleared),
    };
  }).filter((r) => r.active);

  return NextResponse.json({ cur, prev, rows });
}
