import { getViewer, supabaseServer } from '../../../../lib/supabase-server';
import CohortsView from './CohortsView';

export const dynamic = 'force-dynamic';

/** Client cohorts — admin-managed; sharable per cohort via cohort_access
 *  (supabase/cohort_tasks.sql). RLS is the real boundary: an approved
 *  non-admin sees only cohorts they were granted; with no grants the view
 *  renders an empty "nothing shared with you" list. */
export default async function CohortsPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.isApproved) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Your account is not approved yet.
          </div>
        </div>
      </div>
    );
  }
  return <CohortsView isAdmin={viewer.isAdmin} viewerId={viewer.id} />;
}
