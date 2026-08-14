import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Set / clear a Homeless Trust due date for one project + fix-list element
 * (campaign level — deliberately not per record). Admin only, enforced twice:
 * here AND by the dq_due_dates RLS write policy (the write runs under the
 * caller's session, so set_by is attributable to the admin who set it).
 *
 * POST { project: number, metric: 'dq:<el>' | 'eva:<id>', due: 'YYYY-MM-DD' | null }
 *   due = date  → upsert
 *   due = null  → clear
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { project?: unknown; metric?: unknown; due?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const project = Number(body.project);
  const metric = typeof body.metric === 'string' ? body.metric : '';
  const due = body.due == null ? null : String(body.due);
  if (!Number.isFinite(project) || !/^(dq|eva):[a-z0-9_]+$/i.test(metric)) {
    return NextResponse.json({ error: 'project and metric required' }, { status: 400 });
  }
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return NextResponse.json({ error: 'due must be YYYY-MM-DD or null' }, { status: 400 });
  }

  const sb = supabaseServer();
  if (due === null) {
    const { error } = await sb.from('dq_due_dates').delete()
      .eq('project_id', project).eq('metric', metric);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await sb.from('dq_due_dates').upsert(
      { project_id: project, metric, due_date: due, set_by: viewer.id },
      { onConflict: 'project_id,metric' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, project, metric, due });
}
