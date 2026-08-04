import { getViewer } from '../../../../lib/supabase-server';
import CohortsView from './CohortsView';

export const dynamic = 'force-dynamic';

/** Client cohorts — admin-only tracked groups (user decision 2026-08-04).
 *  RLS ("admins all", supabase/cohorts.sql) is the real boundary; this gate
 *  just avoids rendering the shell for non-admins. */
export default async function CohortsPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.isAdmin) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Client cohorts are managed by Homeless Trust administrators.
          </div>
        </div>
      </div>
    );
  }
  return <CohortsView />;
}
