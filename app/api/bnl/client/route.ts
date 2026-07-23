import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Lazy detail fetch for one BNL client — the timeline and the 3-year history
 * card. Both are heavy jsonb, so they stay OUT of the roster query (23k rows)
 * and load only when a drawer opens. Gated by the session (admins only) — the
 * query runs through the user's own client, so the `admins read bnl` RLS policy
 * is the real boundary and a non-admin gets nothing even if they call this
 * route directly.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeBnl) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const pid = new URL(req.url).searchParams.get('pid');
  if (!pid) return NextResponse.json({ error: 'pid required' }, { status: 400 });

  // Everything the drawer shows that the TABLE does not: the heavy jsonb plus
  // the demographic / 3.917 detail fields. Keeping these out of the roster query
  // is what lets the table page 200 rows at a time instead of shipping 23k.
  const { data, error } = await supabaseServer()
    .from('bnl_clients')
    .select('pid, timeline, hist3, dq, entry, days_since_contact, ep_start, ' +
            'times3_sr, months3_sr, dob, sex, race, income, income_date, ' +
            'dv_fleeing, dv_survivor, foster, jj, hoh')
    .eq('pid', pid)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { timeline, hist3, ...detail } = (data ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    timeline: timeline ?? [],
    hist3: hist3 ?? null,
    detail: data ? detail : null,
  });
}
