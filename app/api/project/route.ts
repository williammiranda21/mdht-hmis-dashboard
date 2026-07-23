import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Everything the Project Detail panel needs, in one round-trip:
 *   • the project record (name, type, operating dates)
 *   • its full period history for the current household / subpopulation filter
 *   • peer rows — same project type, same period — for benchmarking
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

  const [historyRes, peerRes] = await Promise.all([
    sb.from('project_metrics')
      .select('period, clients_served, leavers, exits_ph, ph_exit_rate, exits_unsub, unsub_rate, avg_los, is_partial, data')
      .eq('project_id', projectId)
      .eq('granularity', granularity)
      .eq('household_type', household)
      .eq('subpopulation', subpopulation)
      .order('period'),
    // Peers: every project of the same type in this period. project_type is on
    // `projects`, not project_metrics, so filter by the id list rather than a join.
    sb.from('projects').select('project_id').eq('project_type', proj.project_type),
  ]);

  if (historyRes.error) return NextResponse.json({ error: historyRes.error.message }, { status: 500 });

  let peers: unknown[] = [];
  if (!peerRes.error && peerRes.data?.length && period) {
    const ids = peerRes.data.map((p: { project_id: number }) => p.project_id);
    const { data } = await sb
      .from('project_metrics')
      .select('project_id, ph_exit_rate, avg_los, unsub_rate, data')
      .eq('period', period)
      .eq('granularity', granularity)
      .eq('household_type', household)
      .eq('subpopulation', subpopulation)
      .in('project_id', ids);
    peers = data ?? [];
  }

  return NextResponse.json({ project: proj, history: historyRes.data ?? [], peers });
}
