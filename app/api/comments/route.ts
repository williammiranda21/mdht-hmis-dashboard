import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Record-anchored comment threads on a project's fix-list categories.
 * Runs entirely under the caller's session — RLS scopes reads AND writes to
 * the caller's projects (admins see all), so this route adds no scoping of
 * its own beyond input validation.
 *
 * GET  ?project=N            → all threads for the project, grouped client-side
 * POST { project, metric, body } → new comment (author fields from the session)
 * DELETE ?id=N               → own comment (or any, when admin) — RLS enforces
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const project = Number(new URL(req.url).searchParams.get('project'));
  if (!Number.isFinite(project)) return NextResponse.json({ error: 'project required' }, { status: 400 });

  const { data, error } = await supabaseServer()
    .from('dq_comments')
    .select('id, metric, author, author_name, is_admin, body, created_at')
    .eq('project_id', project)
    .order('created_at');
  // Missing table (comments.sql not run yet) degrades to an empty thread list.
  return NextResponse.json({ comments: error ? [] : (data ?? []), viewerId: viewer.id });
}

export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { project?: unknown; metric?: unknown; body?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const project = Number(body.project);
  const metric = typeof body.metric === 'string' ? body.metric : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!Number.isFinite(project) || !/^(dq|eva):[a-z0-9_]+$/i.test(metric)) {
    return NextResponse.json({ error: 'project and metric required' }, { status: 400 });
  }
  if (!text || text.length > 2000) {
    return NextResponse.json({ error: 'body must be 1-2000 characters' }, { status: 400 });
  }

  const { data, error } = await supabaseServer()
    .from('dq_comments')
    .insert({
      project_id: project, metric, body: text,
      author: viewer.id,
      author_name: viewer.displayName || viewer.email || 'User',
      is_admin: viewer.isAdmin,
    })
    .select('id, metric, author, author_name, is_admin, body, created_at')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ comment: data });
}

export async function DELETE(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await supabaseServer().from('dq_comments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
