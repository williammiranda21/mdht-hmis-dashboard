import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Latest matched Youth Connect intake for one HMIS client — feeds the BNL
 * drawer's Youth Connect section during case conferencing.
 *
 * Runs entirely through the caller's session client: youth_intakes' RLS
 * (can_see_yc) is the boundary. A viewer without the grant gets {intake:null},
 * indistinguishable from "no intake", so the drawer simply omits the section.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const pid = new URL(req.url).searchParams.get('pid');
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });

  const { data, error } = await supabaseServer()
    .from('youth_intakes')
    .select('id, created_at, source, contact, sleeping, school_work, unsafe, notes')
    .eq('matched_pid', pid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Missing table (youth_connect.sql not run) or no access both end as null.
  if (error) return NextResponse.json({ intake: null });
  return NextResponse.json({ intake: data ?? null });
}
