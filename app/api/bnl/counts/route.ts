import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import { parseRosterQuery, applyRosterFilters } from '../../../../lib/bnl-query';
import { flagPidsFor } from '../../../../lib/bnl-enrich';

export const dynamic = 'force-dynamic';

const ZERO = { active: 0, housed: 0, inactive: 0, new30: 0, chronic: 0, vet: 0, fam: 0, assessed: 0 };

/**
 * Filtered KPI counts for the BNL header cards (user ask 2026-09-15: the cards
 * follow the roster filters instead of always showing the whole population).
 *
 * Same predicates as the roster query — applyRosterFilters — with `status`
 * forced open, because the cards partition the universe by status themselves.
 * Per-card semantics mirror the per-pop aggregates in bnl_core.py exactly:
 * chronic/new30 count ANY status; vet/fam/assessed count ACTIVE only. Head
 * counts through the caller's session client, so can_see_bnl() RLS holds.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.canSeeBnl) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const p = parseRosterQuery(new URL(req.url).searchParams);
  p.status = '';
  const sb = supabaseServer();

  const pidsIn = await flagPidsFor(sb, p.flag);
  if (pidsIn && !pidsIn.length) return NextResponse.json(ZERO);

  const cnt = async (refine: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count, error } = await refine(base());
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
  const base = () => applyRosterFilters(
    sb.from('bnl_clients').select('pid', { count: 'exact', head: true }), p, pidsIn);

  try {
    const [active, housed, inactive, new30, chronic, vet, fam, assessed] = await Promise.all([
      cnt((q) => q.eq('status', 'active')),
      cnt((q) => q.eq('status', 'housed')),
      cnt((q) => q.eq('status', 'inactive')),
      cnt((q) => q.eq('is_new', true)),
      cnt((q) => q.eq('chronic', true)),
      cnt((q) => q.eq('veteran', true).eq('status', 'active')),
      cnt((q) => q.eq('family', true).eq('status', 'active')),
      cnt((q) => q.not('assessed', 'is', null).eq('status', 'active')),
    ]);
    return NextResponse.json({ active, housed, inactive, new30, chronic, vet, fam, assessed });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
