import { NextResponse } from 'next/server';
import { supabaseServer, getViewer } from '../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Small-multiples performance grid — one series per selected project.
 *
 * The point of the grid is comparison at a glance: with a 26-project portfolio,
 * a table of 26 numbers hides which three are sliding while a wall of 26
 * sparklines sorted worst-first shows it immediately. So this route returns the
 * whole series for every selected project in one go and the client sorts, rather
 * than the server picking a ranking the user cannot see the working for.
 *
 * All four metrics come back together — the client switches between them with no
 * refetch, which is what makes flipping through them feel like one view instead
 * of four page loads. The extra columns are cheap; the round-trip is not, over a
 * TLS-inspecting firewall (see the BNL paging note in CLAUDE.md §6).
 *
 * Nothing is computed here: these are the stored project_metrics columns, the
 * same ones the Project Performance table renders.
 *
 * RLS: aggregates are readable by any approved user — this is a CoC-wide
 * benchmarking dashboard and peer comparison is the feature (supabase/auth_rls.sql).
 * The Deep Dive page still limits the project PICKER to a non-admin's grants.
 */

/** Monthly periods to chart. Two years reads clearly at sparkline size and keeps
 *  the response under the row cap for a realistic selection. */
const WINDOW = 24;
const PAGE = 1000;         // PostgREST caps a response at 1000 rows
const MAX_ROWS = 12000;    // ~150 projects × 24 periods + headroom
const MAX_PROJECTS = 200;

export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!viewer.isApproved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const ids = [...new Set(
    (sp.get('projects') ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
  )].slice(0, MAX_PROJECTS);
  if (!ids.length) return NextResponse.json({ error: 'projects required' }, { status: 400 });

  const household = sp.get('household') ?? 'All';
  const subpopulation = sp.get('subpopulation') ?? 'All';

  const sb = supabaseServer();

  // The authoritative monthly period list lives in meta. Deriving it with a
  // select() over project_metrics would hit the 1000-row cap and return an
  // arbitrary slice — the bug that once made the dashboard show 5 rows.
  const { data: periodsRow } = await sb
    .from('meta').select('value').eq('key', 'periods').maybeSingle();
  const periods = ((periodsRow?.value as string[] | undefined) ?? [])
    .filter((p) => /^\d{4}-\d{2}$/.test(p))
    .slice(-WINDOW);
  if (!periods.length) return NextResponse.json({ error: 'no periods' }, { status: 500 });

  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; ) {
    const { data, error } = await sb
      .from('project_metrics')
      .select('project_id, period, clients_served, exits_ph, ph_exit_rate, avg_los, unsub_rate, is_partial')
      .eq('granularity', 'monthly')
      .eq('household_type', household)
      .eq('subpopulation', subpopulation)
      .in('project_id', ids)
      .in('period', periods)
      .order('project_id').order('period')
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += batch.length;      // advance by rows RECEIVED, never the page size
  }

  // Time to housing for the same projects, so each card can carry its median
  // alongside the trend. One fetch — 200 rows at most.
  const { data: surv } = await sb
    .from('survival_metrics')
    .select('ref_id, event, n, n_housed, median_days, rate_180, type_median, type_rate_180, window_end')
    .eq('scope', 'project')
    .in('ref_id', ids);

  const { data: projs } = await sb
    .from('projects').select('project_id, name, type_name').in('project_id', ids);

  return NextResponse.json({ periods, rows, survival: surv ?? [], projects: projs ?? [] });
}
