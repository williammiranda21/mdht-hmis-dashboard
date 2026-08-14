import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import AnnDetails from '../../../components/AnnDetails';
import type { Announcement } from '../../../components/AnnouncementBar';

export const dynamic = 'force-dynamic';

/** '2026-08-14T…' → 'Aug 14, 2026'. */
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Announcement history — every banner ever posted, newest first: general
 * notices and dashboard updates (badged), with full details + screenshots.
 * ?kind=update is the CHANGELOG view (dashboard features only), ?kind=notice
 * the business notices; no param = everything.
 */
export default async function AnnouncementsPage({ searchParams }: {
  searchParams: { kind?: string };
}) {
  const kind = searchParams.kind === 'update' || searchParams.kind === 'notice'
    ? searchParams.kind : null;
  const viewer = await getViewer();
  let q = supabaseServer()
    .from('announcements')
    .select('id, body, details, kind, created_at, expires_on')
    .order('created_at', { ascending: false })
    .limit(200);
  if (kind) q = q.eq('kind', kind);
  const { data } = await q;
  const rows = (data ?? []) as Announcement[];
  const today = new Date().toISOString().slice(0, 10);

  const seg = (k: string | null, label: string) => (
    <a key={label} href={k ? `/dashboard/announcements?kind=${k}` : '/dashboard/announcements'}
      className="btn" style={{
        fontSize: 12, padding: '3px 12px', textDecoration: 'none',
        ...(kind === k ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 700 } : {}),
      }}>
      {label}
    </a>
  );

  return (
    <div className="panel">
      <div className="panel-h">
        <div>
          <h3>{kind === 'update' ? 'Changelog · dashboard updates' : kind === 'notice' ? 'Notices' : 'Announcements'}</h3>
          <div className="meta">
            {kind === 'update'
              ? 'Every feature and change shipped to this dashboard, newest first'
              : 'Notices and dashboard updates from the Homeless Trust'}
            {viewer?.isAdmin ? ' · post/replace from the banner on any page' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {seg(null, 'All')}
          {seg('update', '✨ Changelog')}
          {seg('notice', '📣 Notices')}
        </div>
      </div>
      {rows.length === 0 && (
        <div className="hc-none">
          {kind === 'update' ? 'No dashboard updates posted yet.' : 'Nothing announced yet.'}
        </div>
      )}
      <div style={{ display: 'grid', gap: 14, padding: '4px 2px 8px' }}>
        {rows.map((a) => {
          const active = !a.expires_on || a.expires_on >= today;
          return (
            <div key={a.id} style={{
              border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px',
              opacity: active ? 1 : 0.75,
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span aria-hidden="true">{a.kind === 'update' ? '✨' : '📣'}</span>
                {a.kind === 'update' && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent)',
                    border: '1px solid var(--accent)', borderRadius: 999, padding: '0 7px' }}>
                    DASHBOARD UPDATE
                  </span>
                )}
                <b style={{ fontSize: 14 }}>{a.body}</b>
                <span className="bnl-sub" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {fmtDate(a.created_at)}{active ? ' · active' : ''}
                </span>
              </div>
              {a.details && <div style={{ marginTop: 6 }}><AnnDetails text={a.details} /></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
