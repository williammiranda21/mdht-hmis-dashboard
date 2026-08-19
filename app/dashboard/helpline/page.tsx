import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import HelplineView, { type HlCase, type Team } from './HelplineView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Helpline Triage' };

/**
 * Helpline Triage — call intake, priority triage, HMIS matching, outreach
 * team assignment, enrollment verification. Admins + helpline_access.
 * RLS on helpline_cases/outreach_teams is the boundary; this gate renders a
 * clear "restricted" instead of an empty shell.
 */
export default async function HelplinePage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.canSeeHelpline) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Helpline Triage is limited to Homeless Trust administrators and helpline staff.
            Ask an administrator for access if you should have it.
          </div>
        </div>
      </div>
    );
  }

  const sb = supabaseServer();
  const [casesRes, teamsRes] = await Promise.all([
    sb.from('helpline_cases')
      .select('*')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(500),
    sb.from('outreach_teams').select('*').order('name'),
  ]);

  // A missing table means supabase/helpline.sql hasn't been run yet.
  const sqlMissing = Boolean(casesRes.error);

  return (
    <HelplineView
      me={viewer.id}
      isAdmin={viewer.isAdmin}
      cases={(casesRes.data ?? []) as HlCase[]}
      teams={(teamsRes.data ?? []) as Team[]}
      sqlMissing={sqlMissing}
    />
  );
}
