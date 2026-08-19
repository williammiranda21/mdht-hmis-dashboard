import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import YouthIntakeView, { type Intake, type Invite } from './YouthIntakeView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Youth Intake' };

/**
 * Youth Connect — intake list, review queue, and invite links.
 * Admins + yc_access (Educate Tomorrow). RLS on youth_intakes/intake_invites
 * is the boundary; this gate just renders a clear "restricted" instead of an
 * empty shell.
 */
export default async function YouthIntakePage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.canSeeYc) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Youth Intake is limited to Homeless Trust administrators and Educate Tomorrow.
            Ask an administrator for access if you should have it.
          </div>
        </div>
      </div>
    );
  }

  const sb = supabaseServer();
  const [intakesRes, invitesRes] = await Promise.all([
    sb.from('youth_intakes')
      .select('id, created_at, source, status, first_name, last_name, dob, ssn4, contact, sleeping, school_work, unsafe, notes, matched_pid, matched_at')
      .order('created_at', { ascending: false })
      .limit(500),
    sb.from('intake_invites')
      .select('token, label, created_at, expires_at, max_uses, uses, disabled')
      .order('created_at', { ascending: false }),
  ]);

  // A missing table means supabase/youth_connect.sql hasn't been run yet —
  // say so instead of rendering an inexplicably empty page.
  const sqlMissing = Boolean(intakesRes.error);

  return (
    <YouthIntakeView
      me={viewer.id}
      intakes={(intakesRes.data ?? []) as Intake[]}
      invites={(invitesRes.data ?? []) as Invite[]}
      sqlMissing={sqlMissing}
    />
  );
}
