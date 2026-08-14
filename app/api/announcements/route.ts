import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/** Yesterday (UTC-day precision is fine for banner lifetimes). */
const yesterday = () =>
  new Date(Date.now() - 86400000).toISOString().slice(0, 10);

/**
 * Admin broadcast banner + release notes ("what's new"). One ACTIVE
 * announcement at a time (the newest non-expired row); posting a new one
 * EXPIRES the previous instead of deleting it, so the table doubles as the
 * dashboard changelog shown at /dashboard/whats-new. Writes run under the
 * admin's session — the announcements RLS policy is the real gate.
 *
 * POST { body, details?, kind?, expires? } → replace the banner (history kept)
 *   kind: 'notice' (default — deadlines, meetings, data issues) | 'update'
 *         (dashboard features; badged on /dashboard/announcements)
 * DELETE → retire the current banner (history kept)
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { body?: unknown; details?: unknown; kind?: unknown; expires?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const details = typeof body.details === 'string' && body.details.trim()
    ? body.details.trim() : null;
  const kind = body.kind === 'update' ? 'update' : 'notice';
  const expires = body.expires == null ? null : String(body.expires);
  if (!text || text.length > 300) {
    return NextResponse.json({ error: 'body must be 1-300 characters' }, { status: 400 });
  }
  if (details !== null && details.length > 5000) {
    return NextResponse.json({ error: 'details must be ≤5000 characters' }, { status: 400 });
  }
  if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    return NextResponse.json({ error: 'expires must be YYYY-MM-DD or null' }, { status: 400 });
  }

  const sb = supabaseServer();
  // Retire (don't delete) whatever is currently active — it stays in history.
  const { error: retireErr } = await sb.from('announcements')
    .update({ expires_on: yesterday() })
    .or(`expires_on.is.null,expires_on.gte.${new Date().toISOString().slice(0, 10)}`);
  if (retireErr) return NextResponse.json({ error: retireErr.message }, { status: 500 });
  const { data, error } = await sb.from('announcements')
    .insert({ body: text, details, kind, expires_on: expires, created_by: viewer.id })
    .select('id, body, details, kind, created_at, expires_on').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ announcement: data });
}

export async function DELETE() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { error } = await supabaseServer().from('announcements')
    .update({ expires_on: yesterday() })
    .or(`expires_on.is.null,expires_on.gte.${new Date().toISOString().slice(0, 10)}`);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
