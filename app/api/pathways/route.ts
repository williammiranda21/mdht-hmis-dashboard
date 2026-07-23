import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Project-scoped pathways — the Sankey + per-state bottleneck for the clients a
 * single project served in the trailing 24 months, traced across their whole
 * system journey (generate_pathways.py §5).
 *
 * One project per call, by the user's design decision: pooling several projects
 * would double-count anyone two of them served. The Deep Dive page picks which
 * project via a dropdown of the selection.
 *
 * Aggregate, non-personal (counts + state-path strings). RLS is the standard
 * approved-user aggregate policy on project_pathways; the Deep Dive page it
 * renders on is itself BNL-gated, so this never widens who sees what.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const projectId = Number(new URL(req.url).searchParams.get('project'));
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: 'project required' }, { status: 400 });
  }

  const { data, error } = await supabaseServer()
    .from('project_pathways')
    .select('project_id, project_name, project_type, n_clients, window_start, window_end, data')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // No row = the project served fewer than the minimum cohort in the window.
  // A real, expected outcome (149 of 232 projects) — the client shows an
  // explanatory empty state rather than treating it as an error.
  if (!data) return NextResponse.json({ pathways: null });

  return NextResponse.json({ pathways: data });
}
