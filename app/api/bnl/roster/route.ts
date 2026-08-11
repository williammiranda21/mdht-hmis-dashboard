import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { parseRosterQuery, queryRoster } from '../../../../lib/bnl-query';
import { enrichRoster, focusPids } from '../../../../lib/bnl-enrich';
import type { BnlClient } from '../../../dashboard/bnl/types';

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
  const sb = supabaseServer();
  // ★ Focused filter: bnl_focus is a side table (no FK to the roster), so
  // resolve the pid list first and constrain the roster query to it.
  let pidsIn: string[] | undefined;
  if (params.flag === 'focus') {
    pidsIn = await focusPids(sb);
    if (!pidsIn.length) return NextResponse.json({ rows: [], total: 0, offset: 0 });
  }
  const { data, error, count } = await queryRoster(sb, params, undefined, true, pidsIn);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as BnlClient[];
  await enrichRoster(sb, rows);   // last-2 notes + focus marks, page-scoped
  return NextResponse.json({ rows, total: count ?? 0, offset: params.offset });
}
