import { supabaseServer, getViewer } from '../../../lib/supabase-server';
import { supabaseAdmin } from '../../../lib/supabase';
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
  // Timestamps ride along for the demand-pattern reporting (day × hour heat).
  const callsByCase: Record<number, number> = {};
  const callLog: { at: string; kind: string }[] = [];
  if (ids.length) {
    const { data: cv } = await sb.from('helpline_calls')
      .select('case_id, kind, received_at')
      .in('case_id', ids)
      .in('kind', ['initial', 'repeat'])
      .limit(5000);
    for (const e of (cv ?? []) as { case_id: number; kind: string; received_at: string }[]) {
      callsByCase[e.case_id] = (callsByCase[e.case_id] ?? 0) + 1;
      callLog.push({ at: e.received_at, kind: e.kind });
    }
  }

  // HMIS glance for MATCHED cases (user 2026-09-11: "a small glance in the
  // triage and team board", not a BNL round-trip). Service role on purpose —
  // helpline staff may lack the BNL grant — but only these five fields leave
  // the roster, the same minimal-disclosure posture as helpline_hmis_flags().
  // The canSeeHelpline gate above is the access boundary.
  const hmis: Record<string, { status: string | null; project: string | null;
    last_contact: string | null; chronic: boolean; veteran: boolean;
    housedNote: string | null; housedOpen: boolean }> = {};
  const mpids = [...new Set(cases.map((c) => c.matched_pid).filter(Boolean))] as string[];
  if (mpids.length) {
    try {
      const { data } = await supabaseAdmin()
        .from('bnl_clients')
        .select('pid, status, project, last_contact, chronic, veteran, timeline, detail')
        .in('pid', mpids);
      for (const r of (data ?? []) as any[]) {
        // HOW they're housed matters (user 2026-09-11): an ACTIVE housing
        // enrollment means the project shown IS their housing provider; a
        // 'housed' from an EXIT DESTINATION (e.g. VA GPD -> VASH subsidy)
        // means the project is just where they exited FROM — the destination
        // is the informative part, and it's a point-in-time claim to verify.
        let housedNote: string | null = null;
        let housedOpen = false;
        if (String(r.status ?? '').toLowerCase().includes('housed')) {
          const tl: any[] = Array.isArray(r.timeline) ? r.timeline : [];
          const open = tl.find((t) => t?.ph && !t?.exit);
          const exited = tl.filter((t) => t?.ph && t?.exit)
            .sort((a, b) => String(b.exit).localeCompare(String(a.exit)))[0];
          if (open) { housedOpen = true; housedNote = `in ${open.project}${open.entry ? ` since ${open.entry}` : ''}`; }
          else if (exited) housedNote = `exited ${exited.project} → ${exited.dest ?? 'permanent housing'} ${exited.exit}`;
          else if (r.detail) housedNote = String(r.detail);
        }
        hmis[String(r.pid)] = {
          status: r.status ?? null, project: r.project ?? null,
          last_contact: r.last_contact ?? null,
          chronic: Boolean(r.chronic), veteran: Boolean(r.veteran),
          housedNote, housedOpen,
        };
      }
    } catch { /* roster unavailable — rows simply skip the glance line */ }
  }

  return (
    <HelplineView
      me={viewer.id}
      // Settings tab + team/priority/resource/area management + queue pins:
      // full admins AND accounts with the helpline_admin grant (RLS enforces
      // the same boundary via is_helpline_admin() — helpline_admin.sql).
      isAdmin={viewer.isHelplineAdmin}
      cases={cases}
      teams={(teamsRes.data ?? []) as Team[]}
      events={events}
      callsByCase={callsByCase}
      callLog={callLog}
      hmis={hmis}
      sqlMissing={sqlMissing}
    />
  );
}
