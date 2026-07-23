import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Client drill-down for a single cell of the Project Performance table.
 *
 * Returns the HASHED PersonalIDs behind one metric, for one project, in one
 * period. These are the same hashed IDs the HMIS export carries — not names —
 * so identifying a person still requires HMIS access. We deliberately do NOT
 * join to bnl_clients for names: the By-Name List is gated by can_see_bnl(),
 * and joining here would leak real names to agency users who only hold a
 * project grant.
 *
 * Runs through the caller's session client, so the `scoped read drill` RLS
 * policy is the real boundary:
 *     is_admin() OR (project_id <> 0 AND can_see_project(project_id))
 * An agency user querying someone else's project simply gets no row back.
 */

/** Table column → the metric key stored in drill_clients (see build_drill_clients). */
const METRICS: Record<string, string> = {
  clients_served: 'c',
  leavers: 'l',
  exits_ph: 'p',
  exits_unsub: 'u',
  LOS_0_30: 'los0',
  LOS_31_90: 'los31',
  LOS_91_180: 'los91',
  LOS_181_365: 'los181',
  LOS_365plus: 'los365',
};

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const period = sp.get('period') ?? '';
  const projectId = Number(sp.get('project_id'));
  const column = sp.get('metric') ?? '';

  if (!period) return NextResponse.json({ error: 'period required' }, { status: 400 });
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 });
  }
  const metric = METRICS[column];
  if (!metric) {
    return NextResponse.json(
      { error: `no drill-down available for "${column}"` },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseServer()
    .from('drill_clients')
    .select('personal_ids')
    .eq('period', period)
    .eq('project_id', projectId)
    .eq('metric', metric)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // No row is the normal result for two very different cases: the metric was
  // zero for that project/period, or RLS filtered it because the caller has no
  // grant on that project. We cannot distinguish them without leaking which
  // projects exist, so both return an empty list.
  return NextResponse.json({ ids: (data?.personal_ids as string[] | undefined) ?? [] });
}
