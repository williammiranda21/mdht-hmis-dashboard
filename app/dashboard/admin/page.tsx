import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import AdminUsers, { type AdminProfile, type ProjectOption } from './AdminUsers';

export const dynamic = 'force-dynamic';

/**
 * User administration — approve signups, grant admin, assign project scope.
 * Admin-only: the RLS policies on profiles/user_projects already refuse
 * non-admins, this check just avoids rendering an empty console.
 */
export default async function AdminPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.isAdmin) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            User administration is limited to Homeless Trust administrators.
          </div>
        </div>
      </div>
    );
  }

  const supabase = supabaseServer();
  const [{ data: profiles }, { data: grants }, { data: projects }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, email, display_name, agency, is_admin, bnl_access, status, created_at')
      .order('created_at', { ascending: false }),
    supabase.from('user_projects').select('user_id, project_id'),
    supabase.from('projects').select('project_id, name, type_name').order('name'),
  ]);

  const byUser = new Map<string, number[]>();
  (grants ?? []).forEach((g: any) => {
    const list = byUser.get(g.user_id) ?? [];
    list.push(Number(g.project_id));
    byUser.set(g.user_id, list);
  });

  const rows: AdminProfile[] = (profiles ?? []).map((p: any) => ({
    id: p.id,
    email: p.email,
    displayName: p.display_name,
    agency: p.agency,
    isAdmin: Boolean(p.is_admin),
    bnlAccess: Boolean(p.bnl_access),
    status: p.status,
    createdAt: p.created_at,
    projectIds: byUser.get(p.id) ?? [],
  }));

  const options: ProjectOption[] = (projects ?? []).map((p: any) => ({
    id: Number(p.project_id),
    name: p.name || `Project ${p.project_id}`,
    type: p.type_name || '',
  }));

  return <AdminUsers me={viewer.id} rows={rows} projects={options} />;
}
