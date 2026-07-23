import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

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

  return NextResponse.json({ project: proj, history: historyRes.data ?? [], peers, dest, survival });
}
