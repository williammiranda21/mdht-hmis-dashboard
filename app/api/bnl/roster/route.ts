import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { parseRosterQuery, queryRoster } from '../../../../lib/bnl-query';

export const dynamic = 'force-dynamic';

/**
 * One page of the By-Name List roster.
 *
 * The table used to be filtered and sorted in the browser over all ~23,800
 * clients; it now asks for a page at a time. Runs through the caller's session
 * client, so `can_see_bnl()` RLS is the real boundary.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeBnl) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const params = parseRosterQuery(new URL(req.url).searchParams);
  const { data, error, count } = await queryRoster(supabaseServer(), params);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rows: data ?? [], total: count ?? 0, offset: params.offset });
}
