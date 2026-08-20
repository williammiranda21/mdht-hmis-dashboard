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
  const cases = (casesRes.data ?? []) as HlCase[];

  // Outreach trail (every ✗/✓ with its date) for ALL loaded cases — the board
  // shows it on open cases, the All-cases list on finished ones.
  const ids = cases.map((c) => c.id);
  const events: Record<number, { at: string; kind: string }[]> = {};
  if (ids.length) {
    const { data } = await sb.from('helpline_calls')
      .select('case_id, received_at, kind')
      .in('case_id', ids)
      .in('kind', ['attempt', 'contact'])
      .order('received_at', { ascending: true })
      .limit(4000);
    for (const e of (data ?? []) as { case_id: number; received_at: string; kind: string }[]) {
      (events[e.case_id] ??= []).push({ at: e.received_at, kind: e.kind });
    }
  }

  // Call VOLUME per case: initial + repeat rows are actual phone calls
  // (cases = people being worked; this is how many times the phone rang).
  const callsByCase: Record<number, number> = {};
  if (ids.length) {
    const { data: cv } = await sb.from('helpline_calls')
      .select('case_id, kind')
      .in('case_id', ids)
      .in('kind', ['initial', 'repeat'])
      .limit(5000);
    for (const e of (cv ?? []) as { case_id: number }[]) {
      callsByCase[e.case_id] = (callsByCase[e.case_id] ?? 0) + 1;
    }
  }

  return (
    <HelplineView
      me={viewer.id}
      isAdmin={viewer.isAdmin}
      cases={cases}
      teams={(teamsRes.data ?? []) as Team[]}
      events={events}
      callsByCase={callsByCase}
      sqlMissing={sqlMissing}
    />
  );
}
