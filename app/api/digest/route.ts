import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { getTargetFlags, type TargetMiss } from '../../../lib/target-flags';
import type { ProjectMetric } from '../../../lib/types';

export const dynamic = 'force-dynamic';

/**
 * Since-last-month digest (Pillar 3) — "what changed" for a set of projects.
 *
 * Compares the LAST TWO COMPLETE months (from meta.dq_periods — the partial
 * in-progress month is deliberately not headlined; it is too noisy to narrate).
 * DQ-ONLY by user decision 2026-08-03 (performance deltas — clients served,
 * PH exit rate, avg LOS — were removed: the performance grid already owns
 * them). Everything is a diff of stored rows:
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

  const [dqRes, drillRes, projRes] = await Promise.all([
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
          // dq:openstay is a latest-month SNAPSHOT (recompute_openstay.py) —
          // it has no prev-month row, so diffing it would report every suspect
          // as "new" every month.
          .neq('metric', 'dq:openstay')
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
  for (const r of [dqRes, drillRes, projRes]) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  }

  const dq = (dqRes.data ?? []) as Array<{ project_id: number; period: string; data: Record<string, unknown> | null }>;
  const drill = (drillRes.data ?? []) as Array<{ project_id: number; period: string; metric: string; personal_ids: string[] | null }>;
  const projInfo = new Map((projRes.data ?? []).map(
    (p: { project_id: number; name: string | null; type_name: string | null }) =>
      [Number(p.project_id), { name: p.name ?? `Project ${p.project_id}`, type: p.type_name }]));

  const pick = <T extends { project_id: number; period: string }>(rows: T[], id: number, period: string): T | undefined =>
    rows.find((r) => Number(r.project_id) === id && r.period === period);

  // ── Fixed since last refresh (dq_snapshots — pipeline/snapshot_dq.py) ───────
  // Diff the PREVIOUS capture against the SAME month as it stands now: the
  // month is complete, so its universe cannot change — every client gone from
  // the captured list is a real data fix, including retroactive ones that the
  // month-vs-month diff above can never see (they rewrite history and
  // evaporate). Gracefully absent until dq_snapshots.sql has run and two
  // captures exist.
  let fixedBase: string | null = null;
  let fixedPeriod: string | null = null;
  const fixedBy = new Map<number, { n: number; top: { label: string; n: number } | null; scorePrev: number | null }>();
  try {
    const { data: datesRow } = await sb.from('meta').select('value').eq('key', 'dq_snapshot_dates').maybeSingle();
    const dates = (datesRow?.value as string[] | null) ?? [];
    if (dates.length >= 2) {
      fixedBase = dates[dates.length - 2];
      const cap: { project_id: number; period: string; metric: string; personal_ids: string[] | null; score: number | null }[] = [];
      for (let from = 0; ; from += 1000) {
        const r = await sb.from('dq_snapshots')
          .select('project_id, period, metric, personal_ids, score')
          .eq('captured_on', fixedBase).in('project_id', ids)
          .order('project_id').order('metric')
          .range(from, from + 999);
        if (r.error) throw r.error;
        cap.push(...((r.data ?? []) as typeof cap));
        if ((r.data ?? []).length < 1000) break;
      }
      if (cap.length) {
        // A capture normally holds ONE period, but a same-day re-run after a
        // load that advanced the month can mix two — diff only the latest.
        fixedPeriod = [...new Set(cap.map((c) => c.period))].sort().pop() ?? null;
        for (let i = cap.length - 1; i >= 0; i--) {
          if (cap[i].period !== fixedPeriod) cap.splice(i, 1);
        }
      }
      if (cap.length && fixedPeriod) {
        const live: { project_id: number; metric: string; personal_ids: string[] | null }[] = [];
        for (let from = 0; ; from += 1000) {
          const r = await sb.from('drill_clients')
            .select('project_id, metric, personal_ids')
            .eq('period', fixedPeriod).in('project_id', ids)
            .or('metric.like.dq:*,metric.like.eva:*')
            .neq('metric', 'dq:openstay')
            .order('project_id').order('metric')
            .range(from, from + 999);
          if (r.error) throw r.error;
          live.push(...((r.data ?? []) as typeof live));
          if ((r.data ?? []).length < 1000) break;
        }
        const liveMap = new Map(live.map((r) => [`${r.project_id}|${r.metric}`, new Set(r.personal_ids ?? [])]));
        for (const c of cap) {
          const pid = Number(c.project_id);
          const e = fixedBy.get(pid) ?? { n: 0, top: null, scorePrev: null };
          if (c.metric === 'score') {
            e.scorePrev = c.score;
            fixedBy.set(pid, e);
            continue;
          }
          const after = liveMap.get(`${pid}|${c.metric}`) ?? new Set<string>();
          let gone = 0;
          for (const p of c.personal_ids ?? []) if (!after.has(p)) gone++;
          if (gone > 0) {
            e.n += gone;
            const label = DQ_SHORT[c.metric]
              ?? (c.metric.startsWith('eva:') ? `check ${c.metric.slice(4)}` : c.metric);
            if (!e.top || gone > e.top.n) e.top = { label, n: gone };
          }
          fixedBy.set(pid, e);
        }
      }
    }
  } catch {
    fixedBase = null;
    fixedPeriod = null;
  }

  const rows = ids.map((id) => {
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

    const fx = fixedBy.get(id);
    const scoreAtBase = fixedPeriod === cur ? score(dqb)
      : fixedPeriod === prev ? score(dqa) : null;
    return {
      project_id: id,
      name: projInfo.get(id)?.name ?? `Project ${id}`,
      type: projInfo.get(id)?.type ?? null,
      dq_score: { prev: score(dqa), cur: score(dqb) },
      err_new: errNew, err_cleared: errCleared,
      top_new_element: topEl,
      fixed_n: fx?.n ?? 0,
      fixed_top: fx?.top ?? null,
      score_since: fx?.scorePrev != null && scoreAtBase != null
        ? scoreAtBase - fx.scorePrev : null,
      // has DQ data either month — projects dark in both are dropped
      active: !!(dqa || dqb || errNew || errCleared || fx?.n),
    };
  }).filter((r) => r.active);

  // ── Off-target headline (user request 2026-08-13) ───────────────────────────
  // Which of these projects are below their admin-set targets for the current
  // complete month, and which FELL below since last month. Reuses
  // lib/target-flags verbatim (same evaluation as the Performance/Rankings
  // chips), both months at monthly All/All. Failure → line simply absent.
  let targets: {
    period: string;
    below: Array<{ project_id: number; name: string; newly: boolean; misses: TargetMiss[] }>;
  } | null = null;
  try {
    // data jsonb rides along for the SO/income target metrics.
    const pmCols = 'project_id, ph_exit_rate, unsub_rate, avg_los, data';
    const [pmCur, pmPrev] = await Promise.all([cur, prev].map((p) =>
      sb.from('project_metrics').select(pmCols)
        .eq('granularity', 'monthly').eq('period', p)
        .eq('household_type', 'All').eq('subpopulation', 'All')
        .in('project_id', ids)));
    const [fCur, fPrev] = await Promise.all([
      getTargetFlags(sb, 'monthly', cur, 'All', 'All', (pmCur.data ?? []) as unknown as ProjectMetric[]),
      getTargetFlags(sb, 'monthly', prev, 'All', 'All', (pmPrev.data ?? []) as unknown as ProjectMetric[]),
    ]);
    // The flag map now carries met AND missed evaluations — a project is
    // "below" only when something is missed, and "newly" means last month
    // had no misses at all (met-or-unevaluated).
    const below = Object.entries(fCur)
      .map(([id, evals]) => ({
        project_id: Number(id),
        name: projInfo.get(Number(id))?.name ?? `Project ${id}`,
        newly: !(fPrev[Number(id)] ?? []).some((e) => !e.met),
        misses: evals.filter((e) => !e.met),
      }))
      .filter((b) => b.misses.length > 0)
      .sort((a, b) => Number(b.newly) - Number(a.newly) || b.misses.length - a.misses.length);
    targets = { period: cur, below };
  } catch {
    targets = null;
  }

  return NextResponse.json({ cur, prev, fixed_base: fixedBase, fixed_period: fixedPeriod, rows, targets });
}
