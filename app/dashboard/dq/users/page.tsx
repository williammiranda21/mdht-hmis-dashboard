import { getViewer } from '../../../../lib/supabase-server';
import UserDqView from './UserDqView';

export const dynamic = 'force-dynamic';

/**
 * Error rates by user (data-entry quality). RLS on user_dq does the scoping:
 * admins see every HMIS user; agency users see exactly the staff visible
 * through their granted projects. This gate only stops pending accounts.
 */
export default async function UserDqPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  if (!viewer.isApproved) {
    return (
      <div className="panel">
        <div className="empty"><strong>Restricted</strong></div>
      </div>
    );
  }
  return <UserDqView />;
}
