import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { supabaseAdmin } from '../../../lib/supabase';
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

  // Last sign-in per account, from Supabase Auth (auth.users isn't reachable
  // through RLS, so this needs the service role — safe here because the page
  // already returned above for non-admins). CAVEAT: only a fresh sign-in
  // stamps last_sign_in_at; a session kept alive by token refresh does not.
  // Treat it as a floor on activity, not a live "last seen".
  const lastSignIn = new Map<string, string | null>();
  try {
    const admin = supabaseAdmin();
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users?.length) break;
      data.users.forEach((u) => lastSignIn.set(u.id, u.last_sign_in_at ?? null));
      if (data.users.length < 200) break;
    }
  } catch { /* auth unreachable — the column just shows "—" */ }

  const supabase = supabaseServer();
  const [{ data: profiles }, { data: grants }, { data: projects }] = await Promise.all([
    supabase
      .from('profiles')
      // '*' so a database where youth_connect.sql (yc_access) hasn't run yet
      // doesn't error the whole console — missing columns read undefined.
      .select('*')
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
    bnlWrite: Boolean(p.bnl_write),
    ycAccess: Boolean(p.yc_access),
    hlAccess: Boolean(p.helpline_access),
    status: p.status,
    createdAt: p.created_at,
    lastSignInAt: lastSignIn.get(p.id) ?? null,
    lastSeenAt: p.last_seen_at ?? null,
    projectIds: byUser.get(p.id) ?? [],
  }));

  const options: ProjectOption[] = (projects ?? []).map((p: any) => ({
    id: Number(p.project_id),
    name: p.name || `Project ${p.project_id}`,
    type: p.type_name || '',
  }));

  return <AdminUsers me={viewer.id} rows={rows} projects={options} />;
}
