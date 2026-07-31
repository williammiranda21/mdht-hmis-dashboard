import { supabaseServer, getViewer } from '../../../../lib/supabase-server';
import TargetsAdmin, { type ProjOpt, type ProjectTargetRow, type TypeTargetRow } from './TargetsAdmin';

export const dynamic = 'force-dynamic';

/**
 * Admin Targets console — set performance targets for a whole project TYPE
 * (type_targets, inherited by every project of that type) or for one PROJECT
 * (project_targets, overrides the type default). Admin-only, like the user
 * console: RLS refuses non-admin writes, this check just avoids rendering.
 *
 * type_targets is created by supabase/targets.sql; until that runs the select
 * errors and we pass typeTableReady=false so the UI shows a setup notice
 * instead of failing saves mysteriously.
 */
export default async function TargetsAdminPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.isAdmin) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Performance targets are managed by Homeless Trust administrators.
          </div>
        </div>
      </div>
    );
  }

  const sb = supabaseServer();
  const [projRes, ptRes, ttRes] = await Promise.all([
    sb.from('projects').select('project_id, name, type_name, project_type').order('name'),
    sb.from('project_targets').select('project_id, metric, target'),
    sb.from('type_targets').select('project_type, metric, target'),
  ]);

  const projects: ProjOpt[] = (projRes.data ?? []).map((p: any) => ({
    id: Number(p.project_id),
    name: p.name || `Project ${p.project_id}`,
    type: p.project_type == null ? null : Number(p.project_type),
    typeName: p.type_name || '',
  }));

  return (
    <TargetsAdmin
      projects={projects}
      projectTargets={(ptRes.data ?? []) as ProjectTargetRow[]}
      typeTargets={(ttRes.data ?? []) as TypeTargetRow[]}
      typeTableReady={!ttRes.error}
    />
  );
}
