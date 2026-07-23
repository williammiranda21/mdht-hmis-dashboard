import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { parseRosterQuery, queryRoster, PAGE_SIZE } from '../../../lib/bnl-query';
import BnlView from './BnlView';
import type { BnlAgg, BnlClient } from './types';

export const dynamic = 'force-dynamic';

/**
 * By-Name List (all populations) — real names, so this is the most sensitive
 * view in the app. Access is enforced twice: middleware requires a session, and
 * the `bnl readers read roster` RLS policy on bnl_clients only returns rows when
 * can_see_bnl() is true. We deliberately use the session client (NOT the
 * service-role key) so RLS is the actual boundary.
 *
 * PERFORMANCE — read before changing the data flow.
 * This page used to select every client (~23,800 rows × 46 columns, 24 MB over
 * 25 paged round-trips) so the browser could filter, sort and count in memory.
 * It took about two minutes. Now it fetches:
 *   • meta.bnl_agg — precomputed KPI counts + inflow/outflow for all six
 *     populations (a few KB; those figures never depended on the other filters)
 *   • ONE page of table rows, with the slim column set
 * Everything else is fetched on demand. Do not reintroduce a full-roster select.
 */
export default async function BnlPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects to /login

  if (!viewer.canSeeBnl) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            The By-Name List contains client-identifying information and is limited to
            Homeless Trust administrators and staff granted access. Contact your
            administrator if you need access.
          </div>
        </div>
      </div>
    );
  }

  const supabase = supabaseServer();
  const params = parseRosterQuery(new URLSearchParams({ limit: String(PAGE_SIZE) }));

  const [aggRes, pageRes] = await Promise.all([
    supabase.from('meta').select('value').eq('key', 'bnl_agg').maybeSingle(),
    queryRoster(supabase, params),
  ]);

  if (pageRes.error) throw pageRes.error;
  const rows = (pageRes.data ?? []) as unknown as BnlClient[];
  const agg = (aggRes.data?.value ?? null) as BnlAgg | null;

  if (!rows.length) {
    return (
      <div className="panel">
        <div className="empty">
          No By-Name List data visible. If the tables were just created, run{' '}
          <code>generate_bnl.py</code> then{' '}
          <code>pipeline/upsert_to_supabase.py --only bnl_clients,bnl_flow</code>. If the data is
          loaded, check that <code>bnl_notes.sql</code> has been run so the{' '}
          <code>bnl readers read roster</code> policy exists.
        </div>
      </div>
    );
  }

  if (!agg) {
    // Aggregates missing → the cards and chart would silently read as zero.
    // Say so rather than render a page full of misleading zeroes.
    return (
      <div className="panel">
        <div className="empty">
          <strong>Roster summary not loaded</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            <code>meta.bnl_agg</code> is missing. Re-run{' '}
            <code>python generate_bnl.py</code> then{' '}
            <code>pipeline/upsert_to_supabase.py --only bnl_clients,meta</code>.
          </div>
        </div>
      </div>
    );
  }

  return <BnlView initialRows={rows} initialTotal={pageRes.count ?? 0} agg={agg} />;
}
