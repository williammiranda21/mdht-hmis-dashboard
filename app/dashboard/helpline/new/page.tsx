import { getViewer } from '../../../../lib/supabase-server';
import CallIntakeForm from './CallIntakeForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New Helpline Call' };

export default async function NewCallPage() {
  const viewer = await getViewer();
  if (!viewer) return null;
  if (!viewer.canSeeHelpline) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Helpline Triage is limited to Homeless Trust administrators and helpline staff.
          </div>
        </div>
      </div>
    );
  }
  return <CallIntakeForm me={viewer.id} />;
}
