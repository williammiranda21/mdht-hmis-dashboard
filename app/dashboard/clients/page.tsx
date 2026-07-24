import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { DRILL_METRICS, DRILL_LABELS } from '../../../lib/drill';
import { periodLabel } from '../../../lib/format';
import CopyIds from './CopyIds';

export const dynamic = 'force-dynamic';

/**
 * Client drill-down — the hashed PersonalIDs behind one table cell, rendered as
 * a real page reached by a normal link (see lib/drill.ts for why: County Web
 * Isolation breaks the in-browser fetch the old modal used, but proxies page
 * navigations fine).
 *
 * Everything is fetched server-side through the caller's session client, so the
 * `scoped read drill` RLS policy is the boundary — an agency user hitting another
 * agency's project simply gets an empty list. Hashed IDs only, never names.
 */
type SP = { metric?: string; project?: string; period?: string; back?: string };

const isSafeBack = (b: string) => b.startsWith('/dashboard'); // never redirect off-site

export default async function ClientsDrillPage({ searchParams }: { searchParams: SP }) {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects
  if (!viewer.isApproved) {
    return (
      <div className="panel"><div className="empty">
        <strong>Restricted</strong>
        <div style={{ marginTop: 8, color: 'var(--muted)' }}>Your account is not approved yet.</div>
      </div></div>
    );
  }

  const metricCol = searchParams.metric ?? '';
  const projectId = Number(searchParams.project);
  const period = searchParams.period ?? '';
  const back = searchParams.back && isSafeBack(searchParams.back) ? searchParams.back : '/dashboard';
  const metric = DRILL_METRICS[metricCol];
  const label = DRILL_LABELS[metricCol] ?? 'Clients';

  const bad = !metric || !period || !Number.isFinite(projectId);

  const sb = supabaseServer();
  const [projRes, drillRes] = bad
    ? [{ data: null }, { data: null }]
    : await Promise.all([
        sb.from('projects').select('name').eq('project_id', projectId).maybeSingle(),
        sb.from('drill_clients').select('personal_ids')
          .eq('period', period).eq('project_id', projectId).eq('metric', metric).maybeSingle(),
      ]);

  const projectName = (projRes.data as { name: string | null } | null)?.name ?? `Project ${projectId}`;
  const ids = ((drillRes.data as { personal_ids: string[] } | null)?.personal_ids) ?? [];

  return (
    <div className="panel" style={{ padding: '18px 20px 22px' }}>
      {/* Plain <a>, not <Link> — a hard navigation is what survives isolation. */}
      <a href={back} className="drill-back">← Back</a>

      {bad ? (
        <div className="bnl-dq" style={{ marginTop: 14 }}>
          That drill-down link is missing information. Go back and click a count again.
        </div>
      ) : (
        <>
          <h3 style={{ marginTop: 12 }}>{label}</h3>
          <div className="bnl-sub" style={{ marginTop: 2 }}>{projectName} · {periodLabel(period)}</div>

          <div className="dr-head" style={{ marginTop: 14 }}>
            <span><b>{ids.length.toLocaleString()}</b> client{ids.length === 1 ? '' : 's'}</span>
            <CopyIds ids={ids} />
          </div>

          {ids.length === 0 ? (
            <div className="hc-none" style={{ textAlign: 'left', paddingLeft: 0 }}>
              No clients to show. Either this metric was zero for the period, or your account does
              not have access to this project.
            </div>
          ) : (
            <>
              <div className="dr-ids">{ids.map((id) => <code key={id}>{id}</code>)}</div>
              <p className="bnl-sub" style={{ marginTop: 10 }}>
                These are hashed PersonalIDs — HMIS access is required to identify individuals.
                Paste one into HMIS client search to look it up.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
