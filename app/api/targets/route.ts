import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { metricByKey } from '../../../lib/target-metrics';

export const dynamic = 'force-dynamic';

/**
 * Performance targets (Pillar 3-4) — admin-set, everyone sees.
 *
 * Two scopes, exactly one per request:
 *   • project_id   → project_targets  (override for one project)
 *   • project_type → type_targets     (default for every project of the type)
 * A project override always beats the type default for that metric.
 *
 * Writes are ADMIN-ONLY, checked here against the session (never the body) AND
 * enforced by RLS (supabase/targets.sql — "admins manage targets").
 * `updated_by` is stamped from the session email server-side. Posting
 * target=null clears the row. Metric keys and per-metric ranges come from
 * lib/target-metrics.ts — the same list the editing UIs render.
 */

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  let payload: { project_id?: number; project_type?: number; metric?: string; target?: number | null };
  try { payload = await req.json(); } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const hasProject = payload.project_id != null;
  const hasType = payload.project_type != null;
  if (hasProject === hasType) {
    return NextResponse.json({ error: 'exactly one of project_id / project_type required' }, { status: 400 });
  }
  const scopeId = Number(hasProject ? payload.project_id : payload.project_type);
  if (!Number.isFinite(scopeId)) {
    return NextResponse.json({ error: `${hasProject ? 'project_id' : 'project_type'} must be a number` }, { status: 400 });
  }
  const metric = String(payload.metric ?? '');
  const def = metricByKey.get(metric);
  if (!def) return NextResponse.json({ error: 'unknown metric' }, { status: 400 });

  const table = hasProject ? 'project_targets' : 'type_targets';
  const scopeCol = hasProject ? 'project_id' : 'project_type';

  const sb = supabaseServer();
  if (payload.target == null) {
    const { error } = await sb.from(table).delete()
      .eq(scopeCol, scopeId).eq('metric', metric);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, cleared: true });
  }

  const target = Number(payload.target);
  if (!Number.isFinite(target) || target < 0 || target > def.max) {
    return NextResponse.json({ error: `target must be 0-${def.max}` }, { status: 400 });
  }
  const { error } = await sb.from(table).upsert({
    [scopeCol]: scopeId, metric, target,
    updated_by: viewer.email ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: `${scopeCol},metric` });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
