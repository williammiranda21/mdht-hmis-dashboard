import { supabaseServer, getViewer } from '../../lib/supabase-server';
import PolicyAttestation from '../../components/PolicyAttestation';
import FieldView from './FieldView';
import type { HlCase, Team } from '../dashboard/helpline/HelplineView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Field Outreach' };

/**
 * Mobile field app for outreach workers (user-approved mock 2026-09-10):
 * see YOUR team's open assignments, navigate/call, and log ✗ attempt /
 * ✓ contact / 🏠 confirmed with one thumb. Deliberately chrome-free — no
 * sidenav, no tabs; workers who need more use the desktop board.
 *
 * Writes are IDENTICAL to the dispatch board's (same events, same counters,
 * same 3-strike rule), so the board reflects field taps in real time.
 * Access = the same helpline gate; the annual P&P attestation gate applies
 * here too — field workers are HMIS users like everyone else.
 */
export default async function FieldPage() {
  const viewer = await getViewer();
  if (!viewer) return null; // middleware redirects to /login

  if (!viewer.canSeeHelpline) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <div className="panel"><div className="empty">
          <strong>Restricted</strong>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            The field app is for outreach staff with helpline access. Ask a Homeless Trust
            administrator to enable it for your account.
          </div>
        </div></div>
      </main>
    );
  }

  const sb = supabaseServer();
  const [casesRes, teamsRes] = await Promise.all([
    sb.from('helpline_cases').select('*')
      .in('status', ['assigned', 'attempted', 'contacted'])
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(200),
    sb.from('outreach_teams').select('*').order('name'),
  ]);

  const teams = (teamsRes.data ?? []) as Team[];
  // Team scope: cases for teams this ACCOUNT is assigned to (TeamAdmin
  // member_accounts). No team assignment (admins, dispatch) = all open cases.
  const mine = teams.filter((t) => (t.member_accounts ?? []).some((a) => a.id === viewer.id));
  const all = (casesRes.data ?? []) as HlCase[];
  const cases = mine.length
    ? all.filter((c) => c.team_id != null && mine.some((t) => t.id === c.team_id))
    : all;

  // Full trail per case — the phone shows the same chronology as the board.
  const ids = cases.map((c) => c.id);
  const events: Record<number, { at: string; kind: string; notes: string | null }[]> = {};
  if (ids.length) {
    const { data } = await sb.from('helpline_calls')
      .select('case_id, received_at, kind, notes')
      .in('case_id', ids)
      .order('received_at', { ascending: true })
      .limit(3000);
    for (const e of (data ?? []) as { case_id: number; received_at: string; kind: string; notes: string | null }[]) {
      (events[e.case_id] ??= []).push({ at: e.received_at, kind: e.kind, notes: e.notes });
    }
  }

  const at = viewer.policiesAttestedAt ? new Date(viewer.policiesAttestedAt).getTime() : null;
  const stale = at == null || Number.isNaN(at) || (Date.now() - at) > 365 * 24 * 60 * 60 * 1000;

  return (
    <>
      {stale && <PolicyAttestation renewal={at != null && !Number.isNaN(at)} email={viewer.email} />}
      <FieldView
        me={viewer.id}
        myName={viewer.displayName || viewer.email || 'Outreach'}
        teamLabel={mine.length ? mine.map((t) => t.name).join(' · ') : 'All teams'}
        scoped={mine.length > 0}
        cases={cases}
        events={events}
      />
    </>
  );
}
