import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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
            'dv_fleeing, dv_survivor, foster, jj, hoh, risk_detail, milestones, ' +
            'hh_n, hh_members, referrals')
    .eq('pid', pid)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { timeline, hist3, ...detail } = (data ?? {}) as Record<string, unknown>;

  // Predictive scores for the drawer strip (user 2026-09-18): housing
  // probability while active (an:predict) + return risk after a recent PH
  // exit (an:risk). Those drill rows are project-scoped by RLS, but this
  // drawer's audience is BNL-cleared (canSeeBnl above) and already sees the
  // client's name, DOB and full timeline — so the score lookup runs on the
  // service client rather than leaving agency-shaped holes in a BNL-wide
  // card. Best-effort: any failure degrades to no strip.
  let risk: {
    housing?: { score: number; state: string | null };
    ret?: { score: number; s6: number | null; bucket: string; exit: string | null };
  } | null = null;
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const admin = createClient(url, key, { auth: { persistSession: false } });
      type Row = { detail: { pid: string; [k: string]: unknown }[] | null };
      const find = (rows: Row[] | null) => {
        for (const r of rows ?? []) {
          const hit = (r.detail ?? []).find((d) => d.pid === pid);
          if (hit) return hit as Record<string, unknown>;
        }
        return null;
      };
      const [pr, rr] = await Promise.all([
        admin.from('drill_clients').select('detail').eq('metric', 'an:predict').contains('personal_ids', [pid]),
        admin.from('drill_clients').select('detail').eq('metric', 'an:risk').contains('personal_ids', [pid]),
      ]);
      const h = find(pr.data as Row[] | null);
      const rt = find(rr.data as Row[] | null);
      risk = {
        ...(h ? { housing: { score: Number(h.score), state: (h.state as string) ?? null } } : {}),
        ...(rt ? { ret: { score: Number(rt.score), s6: rt.s6 != null ? Number(rt.s6) : null,
                          bucket: String(rt.bucket ?? ''), exit: (rt.exit as string) ?? null } } : {}),
      };
      if (!risk.housing && !risk.ret) risk = null;
    }
  } catch { risk = null; }

  return NextResponse.json({
    timeline: timeline ?? [],
    hist3: hist3 ?? null,
    detail: data ? detail : null,
    risk,
  });
}
