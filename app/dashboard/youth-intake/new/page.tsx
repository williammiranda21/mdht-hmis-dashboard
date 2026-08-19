import { getViewer } from '../../../../lib/supabase-server';
import StaffIntakeForm from './StaffIntakeForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New Youth Intake' };

/** Staff intake — same record as a self-entry, richer fields (SSN-4, notes). */
export default async function NewIntakePage() {
  const viewer = await getViewer();
  if (!viewer) return null;
  if (!viewer.canSeeYc) {
    return (
      <div className="panel">
        <div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Youth Intake is limited to Homeless Trust administrators and Educate Tomorrow.
          </div>
        </div>
      </div>
    );
  }
  return <StaffIntakeForm me={viewer.id} />;
}
