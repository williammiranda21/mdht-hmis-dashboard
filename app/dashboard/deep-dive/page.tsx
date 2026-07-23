import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import DeepDiveView from './DeepDiveView';

export const dynamic = 'force-dynamic';

/**
 * Deep Dive — pick your project(s) and see who needs attention.
 *
 * Phase 1 is the worklists only (see /api/deepdive). Phases 2–3 add time-to-
 * housing (Kaplan-Meier), the small-multiples performance grid, pathways/
 * bottleneck and forecasting — all already computed by generate_analytics.py /
 * generate_pathways.py, which embed a JSON payload in their HTML output rather
 * than writing it anywhere reusable.
 *
 * Access: the worklists are client-level and gated by can_see_bnl(), which is
 * stricter than a project grant because the rows carry real names.
 */
export default async function DeepDivePage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.canSeeBnl) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Deep Dive shows client-level worklists and is limited to Homeless Trust
            administrators and staff granted By-Name List access.
          </div>
        </div>
      </div>
    );
  }

  const sb = supabaseServer();

  // Admins pick from everything; a non-admin sees only their granted projects.
  const [{ data: projects }, { data: grants }, { data: periodsRow }] = await Promise.all([
    sb.from('projects').select('project_id, name, type_name').order('name'),
    viewer.isAdmin
      ? Promise.resolve({ data: null })
      : sb.from('user_projects').select('project_id').eq('user_id', viewer.id),
    // Membership comes from drill_clients, which is monthly — so the picker
    // offers the project-side monthly list (it includes the partial month).
    sb.from('meta').select('value').eq('key', 'periods').maybeSingle(),
  ]);

  const periods = ((periodsRow?.value as string[] | undefined) ?? [])
    .filter((p) => /^\d{4}-\d{2}$/.test(p))
    .slice(-24)          // two years is plenty for a worklist view
    .reverse();          // newest first

  const granted = grants?.map((g: { project_id: number }) => Number(g.project_id)) ?? null;
  const options = (projects ?? [])
    .map((p: { project_id: number; name: string | null; type_name: string | null }) => ({
      id: Number(p.project_id), name: p.name ?? `Project ${p.project_id}`, type: p.type_name ?? '',
    }))
    .filter((p) => !granted || granted.includes(p.id));

  return (
    <DeepDiveView
      options={options}
      preselect={granted ?? []}
      isAdmin={viewer.isAdmin}
      periods={periods}
    />
  );
}
