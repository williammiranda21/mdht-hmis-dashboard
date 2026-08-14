import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { buildDiagnosis, type Diagnosis } from '../../../lib/diagnosis';

export const dynamic = 'force-dynamic';

/**
 * Everything the Project Detail panel needs, in one round-trip:
 *   • the project record (name, type, operating dates)
 *   • its full period history for the current household / subpopulation filter
 *   • peer rows — same project type, same period — for benchmarking
 *   • time-to-housing (Kaplan-Meier) for the project and its type — snapshot only
 *
 * Peer statistics are computed on the CLIENT from the rows returned here, using
 * the same percentile/rank logic as the static dashboard's renderPeerBenchmark
 * (apr_monthly_report.py ~line 4983), so both versions rank projects identically.
 *
 * Runs through the caller's session client. Aggregates are readable by any
 * approved user (see supabase/auth_rls.sql — that is deliberate, this is a
 * CoC-wide benchmarking dashboard), so no extra scoping is applied here.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const projectId = Number(sp.get('project_id'));
  const granularity = sp.get('granularity') ?? 'monthly';
  const period = sp.get('period') ?? '';
  const household = sp.get('household') ?? 'All';
  const subpopulation = sp.get('subpopulation') ?? 'All';
  // 'snapshot' = Project Performance; 'returns' = the Returns tab's panel.
  const mode = sp.get('mode') === 'returns' ? 'returns' : 'snapshot';

  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 });
  }

  const sb = supabaseServer();

  const { data: proj, error: projErr } = await sb
    .from('projects')
    .select('project_id, name, project_type, type_name, operating_start, operating_end')
    .eq('project_id', projectId)
    .maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!proj) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  // returns_metrics stores COUNTS only — every rate is derived as
  // band / total_ph_exits * 100, matching the Returns tab and the Python source.
  // Do not add rate columns here; deriving keeps one definition.
  const table = mode === 'returns' ? 'returns_metrics' : 'project_metrics';
  const histCols = mode === 'returns'
    ? 'period, total_ph_exits, returns_lt6mo, returns_6to12mo, returns_13to24mo, returns_2yr'
    : 'period, clients_served, leavers, exits_ph, ph_exit_rate, exits_unsub, unsub_rate, avg_los, is_partial, data';
  const peerCols = mode === 'returns'
    ? 'project_id, total_ph_exits, returns_lt6mo, returns_6to12mo, returns_13to24mo, returns_2yr'
    : 'project_id, ph_exit_rate, avg_los, unsub_rate, data';

  const [historyRes, peerRes] = await Promise.all([
    sb.from(table)
      .select(histCols)
      .eq('project_id', projectId)
      .eq('granularity', granularity)
      .eq('household_type', household)
      .eq('subpopulation', subpopulation)
      .order('period'),
    // Peers: every project of the same type in this period. project_type is on
    // `projects`, not the metrics tables, so filter by id list rather than a join.
    sb.from('projects').select('project_id').eq('project_type', proj.project_type),
  ]);

  if (historyRes.error) return NextResponse.json({ error: historyRes.error.message }, { status: 500 });

  let peers: unknown[] = [];
  if (!peerRes.error && peerRes.data?.length && period) {
    const ids = peerRes.data.map((p: { project_id: number }) => p.project_id);
    const { data } = await sb
      .from(table)
      .select(peerCols)
      .eq('period', period)
      .eq('granularity', granularity)
      .eq('household_type', household)
      .eq('subpopulation', subpopulation)
      .in('project_id', ids);
    peers = data ?? [];
  }

  // Destination breakdown — returns panel only. Monthly-keyed (no granularity
  // column on this table), so it is only meaningful for a monthly period.
  let dest: Record<string, unknown> | null = null;
  if (mode === 'returns' && period) {
    const { data } = await sb
      .from('returns_by_dest')
      .select('data')
      .eq('period', period)
      .eq('project_id', projectId)
      .eq('household_type', household)
      .eq('subpopulation', subpopulation)
      .maybeSingle();
    dest = (data?.data as Record<string, unknown>) ?? null;
  }

  // Time to housing — Kaplan-Meier, computed in generate_analytics.py §3b over a
  // rolling 24-month entry cohort. Two rows: this project, and the same-type
  // baseline it is judged against. Both are fetched (rather than deriving the
  // baseline from the project row's denormalised type_* fields) because the panel
  // draws the peer CURVE, not just its median.
  //
  // Returns mode skips this: that panel answers "do exits stick?", and a
  // time-to-housing curve there would just be a second unrelated chart.
  let survival: { project: unknown | null; type: unknown | null } | null = null;
  if (mode === 'snapshot') {
    const [selfRes, typeRes] = await Promise.all([
      sb.from('survival_metrics').select('*')
        .eq('scope', 'project').eq('ref_id', projectId).maybeSingle(),
      proj.project_type == null
        ? Promise.resolve({ data: null })
        : sb.from('survival_metrics').select('*')
            .eq('scope', 'type').eq('ref_id', proj.project_type).maybeSingle(),
    ]);
    survival = { project: selfRes.data ?? null, type: typeRes.data ?? null };
  }

  // ── Destination profile (Pillar 3) — snapshot mode ──────────────────────────
  // ALL exits by destination code for this project+month (returns_by_dest covers
  // PH exits only). Loaded by pipeline/recompute_dest.py — MONTHLY, COMPLETE
  // months only. When the selected period has no row (the in-progress month —
  // the default view! — or a quarterly/fiscal period), fall back to the
  // project's latest complete month rather than silently hiding the section
  // (user report 2026-08-12); destPeriod tells the UI which month it shows.
  let destProfile: Record<string, number> | null = null;
  let destPeriod: string | null = null;
  if (mode === 'snapshot') {
    if (/^\d{4}-\d{2}$/.test(period)) {
      const { data: dp } = await sb.from('dest_profile').select('data')
        .eq('period', period).eq('project_id', projectId).maybeSingle();
      if (dp?.data) { destProfile = dp.data as Record<string, number>; destPeriod = period; }
    }
    if (!destProfile) {
      const { data: dl } = await sb.from('dest_profile').select('period, data')
        .eq('project_id', projectId).order('period', { ascending: false })
        .limit(1).maybeSingle();
      if (dl?.data) { destProfile = dl.data as Record<string, number>; destPeriod = String(dl.period); }
    }
  }

  // ── Performance diagnosis (Pillar 2) ─────────────────────────────────────────
  // Cross-metric, plain-language read vs same-type peers (lib/diagnosis.ts — an
  // auditable rule library over stored numbers; deliberately NOT a restatement of
  // the per-metric peer chart). Snapshot mode joins outcomes with the project's
  // DQ record; returns mode reads the rows already fetched for the panel.
  let diagnosis: Diagnosis | null = null;
  if (period) {
    const histRows = (historyRes.data ?? []) as unknown as Array<Record<string, unknown>>;
    const latest = histRows.find((h) => h['period'] === period) ?? null;

    let dqData: Record<string, unknown> | null = null;
    if (mode === 'snapshot') {
      const { data } = await sb.from('dq_metrics').select('data')
        .eq('project_id', projectId).eq('granularity', granularity).eq('period', period).maybeSingle();
      dqData = (data?.data ?? null) as Record<string, unknown> | null;
    }

    diagnosis = buildDiagnosis({
      mode,
      typeName: proj.type_name ?? 'similar',
      projectType: proj.project_type ?? null,
      selfProjectId: projectId,
      latest,
      peers: (peers as Array<Record<string, unknown>>),
      survivalProject: (survival?.project as { median_days?: number | null; n?: number | null } | null) ?? null,
      survivalType: (survival?.type as { median_days?: number | null } | null) ?? null,
      dq: dqData,
      dest: (dest as Record<string, { exits?: number | null; returns?: number | null }> | null) ?? null,
    });
  }

  // ── Targets & progress (Pillar 3-4) — snapshot mode ──────────────────────────
  // Admin-set targets (project_targets override > type_targets default; writes
  // via /api/targets, managed centrally at /dashboard/admin/targets). Current
  // values come from the same stored rows the panel already shows, so a target
  // bar can never disagree with the numbers beside it.
  let targets: {
    editable: boolean;
    rows: { metric: string; target: number }[];
    typeRows: { metric: string; target: number }[];
    current: Record<string, number | null>;
    // metric → period its current value actually comes from, ONLY when that
    // differs from the selected period (e.g. DQ score under a partial month).
    asOf?: Record<string, string>;
  } | null = null;
  // Built for BOTH modes since 2026-08-13: the returns drawer shows the
  // return-rate targets (TargetsSection scope='returns'). In returns mode the
  // history rows carry no ph/unsub/los columns, so those currents resolve
  // null — harmless, that scope never renders them.
  if (period) {
    const histRows2 = (historyRes.data ?? []) as unknown as Array<Record<string, unknown>>;
    const latest2 = histRows2.find((h) => h['period'] === period) ?? null;
    const [tRes, ttRes, dqRes2, retRes2] = await Promise.all([
      sb.from('project_targets').select('metric, target').eq('project_id', projectId),
      // Tolerates the table not existing yet (pre-targets.sql): error → no rows.
      proj.project_type == null
        ? Promise.resolve({ data: null })
        : sb.from('type_targets').select('metric, target').eq('project_type', proj.project_type),
      // DQ lives on ITS OWN period list (complete months only — CLAUDE.md §6),
      // while the Projects tab includes the partial current month/quarter/FY.
      // An exact-period lookup therefore returned nothing under any partial
      // period and the DQ target showed "no data" (user report 2026-08-14).
      // Fall back to the latest DQ row AT OR BEFORE the selected period; the
      // period it came from rides along in targets.asOf so the UI can say so.
      // (Key formats sort lexically within a granularity: 2026-08, FY2026-Q3.)
      sb.from('dq_metrics').select('period, data')
        .eq('project_id', projectId).eq('granularity', granularity).lte('period', period)
        .order('period', { ascending: false }).limit(1).maybeSingle(),
      sb.from('returns_metrics').select('total_ph_exits, returns_lt6mo, returns_2yr')
        .eq('project_id', projectId).eq('granularity', granularity).eq('period', period)
        .eq('household_type', household).eq('subpopulation', subpopulation).maybeSingle(),
    ]);
    const dqd = (dqRes2.data?.data ?? null) as Record<string, unknown> | null;
    const dqPeriod = (dqRes2.data?.period ?? null) as string | null;
    const ret = retRes2.data as {
      total_ph_exits: number | null; returns_lt6mo: number | null; returns_2yr: number | null;
    } | null;
    // median_days rides along from the survival row already fetched above — a
    // rolling 24-month cohort figure, NOT keyed to the selected period.
    const sv = (survival?.project ?? null) as { median_days?: number | null } | null;
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    // SO + income targets read the row's data jsonb (snapshot history carries
    // it; returns-mode history doesn't — those metrics never render there).
    const l2d = (latest2?.['data'] ?? null) as Record<string, unknown> | null;
    const soC = num(l2d?.['SOContacts']), soE = num(l2d?.['SOEngagements']);
    targets = {
      editable: viewer.isAdmin,
      rows: ((tRes.data ?? []) as { metric: string; target: number }[]),
      typeRows: ((ttRes.data ?? []) as { metric: string; target: number }[]),
      current: {
        ph_exit_rate: num(latest2?.['ph_exit_rate']),
        unsub_rate: num(latest2?.['unsub_rate']),
        income_impr: num(l2d?.['EarnedIncomeImprovementRate']),
        dq_score: num(dqd?.['DQ_Score']),
        returns_6mo: ret && ret.total_ph_exits ? ((ret.returns_lt6mo ?? 0) / ret.total_ph_exits) * 100 : null,
        returns_2yr: ret && ret.total_ph_exits ? ((ret.returns_2yr ?? 0) / ret.total_ph_exits) * 100 : null,
        avg_los: num(latest2?.['avg_los']),
        median_days: sv?.median_days ?? null,
        pos_outreach_rate: num(l2d?.['PosOutreachRate']),
        so_engagement_rate: soC != null && soC > 0 && soE != null ? (soE / soC) * 100 : null,
      },
      ...(dqd != null && dqPeriod != null && dqPeriod !== period
        ? { asOf: { dq_score: dqPeriod } } : {}),
    };
  }

  return NextResponse.json({ project: proj, history: historyRes.data ?? [], peers, dest, survival, diagnosis, destProfile, destPeriod, targets });
}
