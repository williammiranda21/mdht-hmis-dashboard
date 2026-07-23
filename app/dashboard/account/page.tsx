import { getViewer } from '../../../lib/supabase-server';
import ChangePassword from './ChangePassword';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects

  return (
    <>
      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>My account</h3>
            <div className="meta">Your sign-in details and access level</div>
          </div>
        </div>
        <div className="scroll">
          <table>
            <tbody>
              <tr><td style={{ width: 200, color: 'var(--muted)' }}>Name</td><td>{viewer.displayName || '—'}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Email</td><td>{viewer.email}</td></tr>
              <tr><td style={{ color: 'var(--muted)' }}>Agency</td><td>{viewer.agency || '—'}</td></tr>
              <tr>
                <td style={{ color: 'var(--muted)' }}>Access</td>
                <td>
                  {viewer.isAdmin
                    ? <span className="pill good">Administrator · all projects</span>
                    : <span className="pill good">Approved · assigned projects only</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <ChangePassword />
    </>
  );
}
