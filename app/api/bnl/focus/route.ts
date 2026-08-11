import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Toggle a client's focus mark (bnl_focus — the case-conferencing highlight
 * list). POST { pid, on }. Runs through the session client, so the
 * can_see_bnl RLS policies on bnl_focus are the boundary; insert uses
 * ignoreDuplicates so no UPDATE policy is needed.
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeBnl) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { pid?: string; on?: boolean } | null;
  const pid = (body?.pid ?? '').trim();
  if (!pid || typeof body?.on !== 'boolean') {
    return NextResponse.json({ error: 'pid and on required' }, { status: 400 });
  }

  const sb = supabaseServer();
  const { error } = body.on
    ? await sb.from('bnl_focus').upsert(
        { pid, set_by: viewer.email ?? null },
        { onConflict: 'pid', ignoreDuplicates: true })
    : await sb.from('bnl_focus').delete().eq('pid', pid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, focused: body.on });
}
