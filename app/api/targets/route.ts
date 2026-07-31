import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Per-project performance targets (Pillar 3-4) — admin-set, everyone sees.
 *
 * Writes are ADMIN-ONLY, checked here against the session (never the body);
 * reads happen inside /api/project so the panel gets targets in its normal
 * round-trip. `updated_by` is stamped from the session email server-side.
 * Posting target=null clears the row.
 */

const METRICS = new Set(['ph_exit_rate', 'dq_score', 'returns_2yr']);

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  let payload: { project_id?: number; metric?: string; target?: number | null };
  try { payload = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const projectId = Number(payload.project_id);
  const metric = String(payload.metric ?? '');
  if (!Number.isFinite(projectId)) return NextResponse.json({ error: 'project_id required' }, { status: 400 });
  if (!METRICS.has(metric)) return NextResponse.json({ error: 'unknown metric' }, { status: 400 });

  const sb = supabaseServer();
  if (payload.target == null) {
    const { error } = await sb.from('project_targets').delete()
      .eq('project_id', projectId).eq('metric', metric);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, cleared: true });
  }

  const target = Number(payload.target);
  if (!Number.isFinite(target) || target < 0 || target > 100) {
    return NextResponse.json({ error: 'target must be 0-100' }, { status: 400 });
  }
  const { error } = await sb.from('project_targets').upsert({
    project_id: projectId, metric, target,
    updated_by: viewer.email ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'project_id,metric' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
