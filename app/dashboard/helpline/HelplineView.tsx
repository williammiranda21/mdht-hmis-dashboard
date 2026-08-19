'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import { fmtInt } from '../../../lib/format';
import { AREAS, MAX_FAILED_ATTEMPTS, priorityBand, type CaseStatus } from '../../../lib/helpline-options';

export interface HlCase {
  id: number;
  created_at: string;
  status: CaseStatus;
  first_name: string | null;
  last_name: string | null;
  dob: string | null;
  ssn4: string | null;
  phone_line: string | null;
  phone_callback: string | null;
  area: string | null;
  landmark: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  sleeping: string | null;
  household: string | null;
  factors: string[];
  notes: string | null;
  priority: number;
  team_id: number | null;
  assigned_at: string | null;
  attempts: number;
  last_attempt: string | null;
  contacts: number;
  last_contact: string | null;
  matched_pid: string | null;
  confirmed_at: string | null;
  verified_entry: string | null;
  verified_proj: string | null;
}
export interface Team {
  id: number; name: string; project_id: number | null;
  zones: string[]; factors: string[]; active: boolean;
}
interface Candidate {
  pid: string; name: string; dob: string | null; score: number; why: string[];
  bnl: { status: string | null; project: string | null; last_contact: string | null } | null;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function hoursSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
}
function nameOf(r: HlCase): string {
  return [r.first_name, r.last_name].filter(Boolean).join(' ') || '(anonymous caller)';
}
function bandColor(band: string): string {
  return band === 'HIGH' ? 'var(--danger)' : band === 'MED' ? 'var(--warn)' : 'var(--faint)';
}

const STATUS_CHIP: Record<CaseStatus, [string, string, string]> = {
  new: ['new', 'var(--warn-light)', 'var(--warn)'],
  assigned: ['assigned', 'var(--primary-light)', 'var(--secondary)'],
  attempted: ['attempted', 'var(--primary-light)', 'var(--secondary)'],
  contacted: ['contacted', 'var(--accent-light)', 'var(--accent)'],
  confirmed: ['confirmed homeless', 'var(--accent-light)', 'var(--accent)'],
  declined: ['declined help', 'var(--track)', 'var(--muted)'],
  no_locate: ['could not locate', 'var(--track)', 'var(--muted)'],
  closed: ['closed', 'var(--track)', 'var(--muted)'],
};
function Chip({ s }: { s: CaseStatus }) {
  const [label, bg, fg] = STATUS_CHIP[s];
  return <span className="bnl-chip" style={{ background: bg, color: fg }}>{label}</span>;
}

/** Suggested team: factor routing outranks geography; ties broken by fewer
 *  open cases. Suggest-only — the operator picks the team either way. */
function suggestTeam(c: HlCase, teams: Team[], openByTeam: Map<number, number>): Team | null {
  const active = teams.filter((t) => t.active);
  const load = (t: Team) => openByTeam.get(t.id) ?? 0;
  const factorHit = active.filter((t) =>
    t.factors.some((f) => (f === 'veteran' && c.factors.includes('Veteran'))
      || (f === 'youth' && c.factors.includes('Youth 18–24'))
      || (f === 'family' && c.household === 'With children')));
  if (factorHit.length) return factorHit.sort((a, b) => load(a) - load(b))[0];
  const zoneHit = active.filter((t) => c.area && t.zones.includes(c.area));
  if (zoneHit.length) return zoneHit.sort((a, b) => load(a) - load(b))[0];
  return null;
}

const OPEN_STATUSES: CaseStatus[] = ['assigned', 'attempted', 'contacted'];

export default function HelplineView({ me, isAdmin, cases, teams, sqlMissing }: {
  me: string; isAdmin: boolean; cases: HlCase[]; teams: Team[]; sqlMissing: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [cands, setCands] = useState<Record<number, Candidate[] | 'loading'>>({});
  const [q, setQ] = useState('');

  const db = () => supabaseBrowser();
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const openByTeam = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of cases) {
      if (c.team_id != null && OPEN_STATUSES.includes(c.status)) {
        m.set(c.team_id, (m.get(c.team_id) ?? 0) + 1);
      }
    }
    return m;
  }, [cases]);

  async function run(fn: () => Promise<{ error: unknown }>) {
    setBusy(true); setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) { setError(String((e as any)?.message ?? e)); return false; }
    router.refresh();
    return true;
  }

  const update = (id: number, patch: Record<string, unknown>) =>
    run(async () => db().from('helpline_cases').update(patch).eq('id', id));

  const assign = (c: HlCase, teamId: number) =>
    update(c.id, { team_id: teamId, status: 'assigned', assigned_at: new Date().toISOString() });

  // Failed try and successful contact are SEPARATE facts (user call
  // 2026-08-19): each bumps its own counter, and status only moves FORWARD —
  // a failed try after a successful contact never downgrades the case.
  // 3-strike rule: the Nth failed attempt with zero successful contacts
  // auto-closes as no_locate (Reopen stays one click away).
  const logAttempt = (c: HlCase) => {
    const attempts = c.attempts + 1;
    const strikeOut = attempts >= MAX_FAILED_ATTEMPTS && (c.contacts ?? 0) === 0
      && ['assigned', 'attempted'].includes(c.status);
    return update(c.id, {
      status: strikeOut ? 'no_locate' : c.status === 'assigned' ? 'attempted' : c.status,
      attempts,
      last_attempt: new Date().toISOString().slice(0, 10),
    });
  };

  const logContact = (c: HlCase) =>
    update(c.id, {
      status: ['assigned', 'attempted'].includes(c.status) ? 'contacted' : c.status,
      contacts: (c.contacts ?? 0) + 1,
      last_contact: new Date().toISOString().slice(0, 10),
    });

  async function findMatches(id: number) {
    setOpenId(id);
    setCands((p) => ({ ...p, [id]: 'loading' }));
    try {
      const res = await fetch(`/api/helpline/match?id=${id}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'match failed');
      setCands((p) => ({ ...p, [id]: j.candidates as Candidate[] }));
    } catch (e) {
      setError(String((e as Error).message));
      setCands((p) => ({ ...p, [id]: [] }));
    }
  }

  const confirmMatch = (c: HlCase, pid: string) =>
    update(c.id, { matched_pid: pid, matched_by: me, matched_at: new Date().toISOString() });

  const triage = cases.filter((c) => c.status === 'new');
  const working = cases.filter((c) => OPEN_STATUSES.includes(c.status));
  const confirmed = cases.filter((c) => c.status === 'confirmed');
  const done = cases.filter((c) => ['declined', 'no_locate', 'closed'].includes(c.status));
  const verified = confirmed.filter((c) => c.verified_entry);
  const unverified = confirmed.filter((c) => !c.verified_entry);

  const t = q.trim().toLowerCase();
  const searchable = (c: HlCase) =>
    `${nameOf(c)} ${c.phone_line ?? ''} ${c.phone_callback ?? ''} ${c.area ?? ''} ${c.address ?? ''} ${c.notes ?? ''}`.toLowerCase();

  const kpi = (lbl: string, val: number, note: string, kc: string) => (
    <div className="bnl-kpi" style={{ ['--kc' as any]: kc }}>
      <div className="bnl-kpi-lbl">{lbl}</div>
      <div className="bnl-kpi-val">{fmtInt(val)}</div>
      <div className="bnl-kpi-note">{note}</div>
    </div>
  );

  function CaseCell({ c }: { c: HlCase }) {
    const band = priorityBand(c.priority);
    return (
      <td>
        <span className="bnl-sub" title="Case number — use this when referencing the case"
          style={{ fontVariantNumeric: 'tabular-nums' }}>#{c.id}</span>{' '}
        <span className="bnl-nm">{nameOf(c)}</span>{' '}
        <b style={{ color: bandColor(band), fontSize: 11 }}>{band}</b>
        <div className="bnl-sub" style={{ lineHeight: 1.6 }}>
          {c.area ?? 'area unknown'}{c.address ? ` · ${c.address}` : ''}{c.landmark ? ` · ${c.landmark}` : ''}
          {c.sleeping ? ` · ${c.sleeping}` : ''}{c.household && c.household !== 'Alone' ? ` · ${c.household}` : ''}
          {c.factors.length > 0 && <> · {c.factors.join(', ')}</>}
          {(c.phone_callback || c.phone_line) && <> · ☎ {c.phone_callback ?? c.phone_line}</>}
          {c.matched_pid && <> · <span className="bnl-fp bnl-fp-sch">HMIS linked</span></>}
        </div>
      </td>
    );
  }

  function MatchPanel({ c }: { c: HlCase }) {
    const list = cands[c.id];
    return (
      <div style={{ padding: '6px 12px 14px' }}>
        {list === 'loading' && <div className="meta">Searching 50k HMIS clients…</div>}
        {Array.isArray(list) && list.length === 0 && (
          <div className="meta">No HMIS candidates — needs a name and DOB/SSN-4 to match well.</div>
        )}
        {Array.isArray(list) && list.map((m) => (
          <div key={m.pid} style={{
            border: '1px solid var(--border)', borderRadius: 10, padding: '9px 13px',
            marginBottom: 8, background: 'var(--card)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span className="bnl-nm" style={{ textTransform: 'capitalize' }}>{m.name || '(no name)'}</span>
              <b>{m.score}%</b>
            </div>
            <div className="bnl-sub">
              {m.why.join(' · ')}
              {m.bnl ? <> · BNL: <b>{m.bnl.status}</b>{m.bnl.last_contact ? ` · last contact ${m.bnl.last_contact}` : ''}</>
                : ' · not on the BNL'}
            </div>
            <button className="tbtn" style={{ marginTop: 6 }} disabled={busy}
              onClick={() => confirmMatch(c, m.pid)}>Confirm match</button>
          </div>
        ))}
      </div>
    );
  }

  function AssignControls({ c }: { c: HlCase }) {
    const sug = suggestTeam(c, teams, openByTeam);
    return (
      <div style={{ whiteSpace: 'nowrap' }}>
        {sug && (
          <button className="btn primary" style={{ padding: '5px 12px', fontSize: 12 }}
            disabled={busy} title={`Suggested: covers ${c.area ?? '?'} — ${openByTeam.get(sug.id) ?? 0} open cases`}
            onClick={() => assign(c, sug.id)}>
            Assign → {sug.name.length > 26 ? `${sug.name.slice(0, 24)}…` : sug.name}
          </button>
        )}
        <select className="fselect" aria-label="Assign to team" defaultValue=""
          style={{ marginLeft: 6, minWidth: 120, padding: '5px 26px 5px 9px', fontSize: 12 }}
          onChange={(e) => { if (e.target.value) assign(c, Number(e.target.value)); }}>
          <option value="" disabled>{sug ? 'Other team…' : 'Assign team…'}</option>
          {teams.filter((x) => x.active).map((x) => (
            <option key={x.id} value={x.id}>{x.name} ({openByTeam.get(x.id) ?? 0} open)</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <>
      {sqlMissing && (
        <div className="lerror" style={{ marginBottom: 14 }} role="alert">
          Helpline tables aren&rsquo;t set up yet — run supabase/helpline.sql in the Supabase
          SQL editor, then reload.
        </div>
      )}
      {error && <div className="lerror" style={{ marginBottom: 14 }} role="alert">{error}</div>}

      <div className="bnl-kpis" style={{ marginBottom: 18 }}>
        {kpi('Awaiting triage', triage.length,
          triage.length ? `oldest ${Math.max(...triage.map((c) => hoursSince(c.created_at)))}h ago` : 'queue is clear',
          'var(--warn)')}
        {kpi('With outreach', working.length, 'assigned · attempted · contacted', 'var(--secondary)')}
        {kpi('Confirmed homeless', confirmed.length,
          `${fmtInt(verified.length)} verified enrolled · ${fmtInt(unverified.length)} pending`, 'var(--accent)')}
        {kpi('Enrollment gap', unverified.length,
          unverified.length ? 'confirmed but no HMIS enrollment yet' : 'everyone confirmed is enrolled', 'var(--danger)')}
        {kpi('All cases', cases.length, `${fmtInt(done.length)} closed/other`, 'var(--faint)')}
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Triage queue</h3>
            <div className="meta">New calls, highest priority first · suggestion = factors, then geography, then load</div>
          </div>
          <Link className="btn primary" href="/dashboard/helpline/new">☎ New call</Link>
        </div>
        {triage.length > 0 && (
          <div className="scroll"><table className="bnl-table">
            <thead><tr><th>Called</th><th>Caller</th><th>HMIS</th><th style={{ textAlign: 'right' }}>Assignment</th></tr></thead>
            <tbody>
              {triage.map((c) => (
                <FragmentRow key={c.id} left={<>{when(c.created_at)}
                  <div className="bnl-sub" style={hoursSince(c.created_at) >= 24 ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                    {hoursSince(c.created_at)}h ago{hoursSince(c.created_at) >= 24 ? ' ⚠' : ''}</div></>}>
                  <CaseCell c={c} />
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {c.matched_pid
                      ? <span className="pill" style={{ background: 'var(--accent-light)', color: 'var(--accent)', borderRadius: 20, padding: '3px 11px', fontSize: 11, fontWeight: 700 }}>linked</span>
                      : <button className="tbtn" disabled={busy} onClick={() => findMatches(c.id)}>
                          {openId === c.id ? 'Refresh' : 'Find matches'}</button>}
                  </td>
                  <td style={{ textAlign: 'right' }}><AssignControls c={c} /></td>
                  {openId === c.id ? <MatchPanel c={c} /> : null}
                </FragmentRow>
              ))}
            </tbody>
          </table></div>
        )}
        {!triage.length && !sqlMissing && (
          <div className="empty" style={{ padding: '10px 18px 16px' }}>Nothing waiting — new calls land here.</div>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Team board</h3>
            <div className="meta">Open cases by outreach team · log attempts, record the outcome, print the dispatch sheet</div>
          </div>
        </div>
        {teams.filter((x) => (openByTeam.get(x.id) ?? 0) > 0).map((team) => (
          <div key={team.id} style={{ padding: '0 12px 8px' }}>
            <div style={{ fontWeight: 700, color: 'var(--strong)', padding: '8px 6px 4px', fontSize: 13.5 }}>
              {team.name} <span className="bnl-sub">· {fmtInt(openByTeam.get(team.id) ?? 0)} open
              {team.zones.length ? ` · covers ${team.zones.join(', ')}` : ' · no zones set'}</span>
            </div>
            <div className="scroll"><table className="bnl-table">
              <tbody>
                {working.filter((c) => c.team_id === team.id).map((c) => (
                  <tr key={c.id} style={{ cursor: 'default' }}>
                    <CaseCell c={c} />
                    <td style={{ whiteSpace: 'nowrap' }}><Chip s={c.status} />
                      {c.attempts > 0 && <div className="bnl-sub">✗ tried ×{c.attempts}{c.last_attempt ? ` · ${c.last_attempt}` : ''}</div>}
                      {(c.contacts ?? 0) > 0 && <div className="bnl-sub" style={{ color: 'var(--accent)' }}>
                        ✓ contacted ×{c.contacts}{c.last_contact ? ` · ${c.last_contact}` : ''}</div>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Link className="tbtn" href={`/dashboard/helpline/print/${c.id}`} target="_blank"
                        title="One-page dispatch sheet — print or save as PDF for the field team">🖨 Sheet</Link>
                      <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
                        title={`Went out, couldn't reach them — bumps the tried counter. ${MAX_FAILED_ATTEMPTS} failed tries with no successful contact auto-closes the case as could-not-locate.`}
                        onClick={() => logAttempt(c)}>
                        ✗ Couldn&rsquo;t contact{(c.contacts ?? 0) === 0 && c.attempts === MAX_FAILED_ATTEMPTS - 1 ? ' (final)' : ''}</button>
                      <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
                        title="Reached them — bumps the contacted counter; failed tries never erase this"
                        onClick={() => logContact(c)}>✓ Contacted</button>
                      <button className="btn primary" style={{ marginLeft: 6, padding: '5px 12px', fontSize: 12 }} disabled={busy}
                        title="Outreach verified this person is homeless — starts the enrollment-verification clock"
                        onClick={() => update(c.id, { status: 'confirmed', confirmed_at: new Date().toISOString().slice(0, 10) })}>
                        Confirmed homeless</button>
                      <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
                        title="FINAL — closes the case and removes it from this board. “Couldn't find them today” is Log attempt, not this."
                        onClick={() => {
                          const warn = c.attempts === 0
                            ? 'No attempts have been logged on this case.\n\n'
                            : `${c.attempts} attempt${c.attempts === 1 ? '' : 's'} logged.\n\n`;
                          if (confirm(`${warn}Close this case as COULD NOT LOCATE? It leaves the team board (it can be reopened from All cases).`)) {
                            update(c.id, { status: 'no_locate' });
                          }
                        }}>Close · can&rsquo;t locate</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        ))}
        {!working.length && <div className="empty" style={{ padding: '10px 18px 16px' }}>No assigned cases yet.</div>}
      </div>

      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>All cases</h3>
            <div className="meta">Confirmed cases verify against each weekly HMIS export — the
              <b style={{ color: 'var(--danger)' }}> enrollment gap</b> list is the one to watch</div>
          </div>
          <input className="finput" placeholder="Search name, phone, area, notes…"
            value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }}
            aria-label="Search cases" />
        </div>
        <div className="scroll"><table className="bnl-table">
          <thead><tr><th>Caller</th><th>Called</th><th>Team</th><th>Status</th><th>Attempts</th><th>Enrollment</th><th style={{ textAlign: 'right' }}></th></tr></thead>
          <tbody>
            {[...confirmed, ...done].filter((c) => !t || searchable(c).includes(t)).map((c) => (
              <tr key={c.id} style={{ cursor: 'default' }}>
                <CaseCell c={c} />
                <td style={{ whiteSpace: 'nowrap' }}>{when(c.created_at)}</td>
                <td>{c.team_id != null ? (teamById.get(c.team_id)?.name ?? '?') : '—'}</td>
                <td><Chip s={c.status} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {/* how hard was this case worked — matters most on no-locates */}
                  {c.attempts > 0
                    ? <><b>×{c.attempts}</b>{c.last_attempt && <span className="bnl-sub"> · last {c.last_attempt}</span>}</>
                    : <span className="bnl-sub"
                        style={c.status === 'no_locate' ? { color: 'var(--danger)', fontWeight: 700 } : undefined}
                        title={c.status === 'no_locate' ? 'Closed as could-not-locate with no attempt ever logged' : undefined}>
                        {c.status === 'no_locate' ? 'none logged ⚠' : '—'}</span>}
                </td>
                <td>
                  {c.status !== 'confirmed' ? <span className="bnl-sub">—</span>
                    : c.verified_entry
                      ? <><span className="bnl-chip" style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>✓ enrolled {c.verified_entry}</span>
                          <div className="bnl-sub">{c.verified_proj}</div></>
                      : <span className="bnl-chip" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>
                          not enrolled · {c.confirmed_at ? `${Math.floor((Date.now() - new Date(c.confirmed_at).getTime()) / 86_400_000)}d` : '?'}</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Link className="tbtn" href={`/dashboard/helpline/print/${c.id}`} target="_blank">🖨 Sheet</Link>
                  {c.matched_pid && (
                    <Link className="tbtn" style={{ marginLeft: 6 }}
                      href={`/dashboard/bnl?pid=${encodeURIComponent(c.matched_pid)}`}>BNL →</Link>
                  )}
                  {['no_locate', 'declined', 'closed'].includes(c.status) && (
                    <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
                      title="Back to the team board (keeps the team) — e.g. a new sighting or the caller called again"
                      onClick={() => update(c.id, { status: c.team_id != null ? 'assigned' : 'new' })}>
                      Reopen</button>
                  )}
                </td>
              </tr>
            ))}
            {!confirmed.length && !done.length && (
              <tr><td colSpan={7} className="empty" style={{ cursor: 'default' }}>
                Cases appear here once outreach records an outcome.</td></tr>
            )}
          </tbody>
        </table></div>
      </div>

      <Reporting cases={cases} teams={teams} />

      {isAdmin && <TeamZones teams={teams} busy={busy} onSave={(id, zones, factors) =>
        run(async () => db().from('outreach_teams').update({ zones, factors }).eq('id', id))} />}
    </>
  );
}

/** Renders a case row spanning the standard cells + optional expansion row. */
function FragmentRow({ left, children }: { left: React.ReactNode; children: React.ReactNode[] | React.ReactNode }) {
  const kids = Array.isArray(children) ? children : [children];
  const cells = kids.slice(0, 3);
  const expand = kids[3] ?? null;
  return (
    <>
      <tr style={{ cursor: 'default' }}>
        <td style={{ whiteSpace: 'nowrap' }}>{left}</td>
        {cells}
      </tr>
      {expand ? (
        <tr style={{ cursor: 'default' }}>
          <td colSpan={4} style={{ background: 'var(--rowhover)' }}>{expand}</td>
        </tr>
      ) : null}
    </>
  );
}

/** Median of a numeric list; null when empty. */
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-team performance table (user ask 2026-08-19): assigned / open /
 * confirmed / verified-enrolled / no-locate / declined, plus median hours
 * from call to assignment. Computed from the loaded cases (newest 500) —
 * when volume outgrows that, this moves server-side; the columns won't change.
 */
function Reporting({ cases, teams }: { cases: HlCase[]; teams: Team[] }) {
  const rows = useMemo(() => {
    const byTeam = new Map<number | null, HlCase[]>();
    for (const c of cases) {
      const k = c.team_id ?? null;
      byTeam.set(k, [...(byTeam.get(k) ?? []), c]);
    }
    const mk = (label: string, list: HlCase[]) => {
      const assignHrs = list
        .filter((c) => c.assigned_at)
        .map((c) => (new Date(c.assigned_at!).getTime() - new Date(c.created_at).getTime()) / 3_600_000)
        .filter((h) => h >= 0);
      return {
        label,
        total: list.length,
        open: list.filter((c) => OPEN_STATUSES.includes(c.status)).length,
        confirmed: list.filter((c) => c.status === 'confirmed').length,
        enrolled: list.filter((c) => c.verified_entry).length,
        noLocate: list.filter((c) => c.status === 'no_locate').length,
        declined: list.filter((c) => c.status === 'declined').length,
        medAssign: median(assignHrs),
      };
    };
    const out = teams
      .map((t) => mk(t.name, byTeam.get(t.id) ?? []))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    const unassigned = byTeam.get(null) ?? [];
    if (unassigned.length) out.push(mk('(never assigned)', unassigned));
    out.push({ ...mk('All teams', cases), label: 'All teams' });
    return out;
  }, [cases, teams]);

  function downloadCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['team', 'cases', 'open_now', 'confirmed_homeless', 'verified_enrolled',
      'no_locate', 'declined', 'median_hours_to_assignment'];
    const body = rows.map((r) => [r.label, r.total, r.open, r.confirmed, r.enrolled,
      r.noLocate, r.declined, r.medAssign == null ? '' : r.medAssign.toFixed(1)].map(esc).join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `helpline_teams_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h">
        <div>
          <h3>Team reporting</h3>
          <div className="meta">Latest {fmtInt(cases.length)} cases · confirmed → enrolled is the
            promise; median call→assignment is the dispatch speed</div>
        </div>
        <button className="tbtn" onClick={downloadCsv}>⬇ CSV</button>
      </div>
      <div className="scroll"><table className="bnl-table">
        <thead><tr>
          <th>Team</th><th className="num">Cases</th><th className="num">Open now</th>
          <th className="num">Confirmed</th><th className="num">Enrolled ✓</th>
          <th className="num">No-locate</th><th className="num">Declined</th>
          <th className="num">Call → assigned</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} style={{ cursor: 'default',
              ...(r.label === 'All teams' ? { fontWeight: 700 } : {}) }}>
              <td className={r.label === 'All teams' ? 'bnl-nm' : undefined}>{r.label}</td>
              <td className="num">{fmtInt(r.total)}</td>
              <td className="num">{r.open ? fmtInt(r.open) : <span className="bnl-sub">—</span>}</td>
              <td className="num">{r.confirmed ? fmtInt(r.confirmed) : <span className="bnl-sub">—</span>}</td>
              <td className="num" style={r.enrolled ? { color: 'var(--accent)', fontWeight: 700 } : undefined}>
                {r.enrolled ? fmtInt(r.enrolled) : <span className="bnl-sub">—</span>}</td>
              <td className="num">{r.noLocate ? fmtInt(r.noLocate) : <span className="bnl-sub">—</span>}</td>
              <td className="num">{r.declined ? fmtInt(r.declined) : <span className="bnl-sub">—</span>}</td>
              <td className="num">{r.medAssign == null ? <span className="bnl-sub">—</span>
                : r.medAssign < 1 ? `${Math.round(r.medAssign * 60)}m`
                : `${r.medAssign.toFixed(1)}h`}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

/** Routing tags a team can carry — factor routing outranks geography. Fixed
 *  list, same closed-domain rule as everything else. */
const TEAM_TAGS: { key: string; label: string }[] = [
  { key: 'veteran', label: 'Veterans' },
  { key: 'youth', label: 'Youth 18–24' },
  { key: 'family', label: 'Families with children' },
];

/**
 * Admin-only coverage editor. Zones are TAP-CHIPS from the same AREAS list the
 * intake form uses — a typed "hialeah" can never miss "Hialeah" because
 * nothing is typed. Saving is explicit: the button only lights up when
 * something changed, and a confirmation names exactly what was saved.
 */
function TeamZones({ teams, busy, onSave }: {
  teams: Team[]; busy: boolean;
  onSave: (id: number, zones: string[], factors: string[]) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const startEdit = (t: Team) => {
    setEditing(t.id);
    setZones([...t.zones]);
    setTags([...t.factors]);
    setSaved(null);
  };
  const dirty = (t: Team) =>
    JSON.stringify([...zones].sort()) !== JSON.stringify([...t.zones].sort())
    || JSON.stringify([...tags].sort()) !== JSON.stringify([...t.factors].sort());

  async function save(t: Team) {
    const ok = await onSave(t.id, zones, tags);
    if (ok) {
      setSaved(`Saved — ${t.name} now covers ${zones.length ? zones.join(', ') : 'no areas'}`
        + (tags.length ? ` · routes ${tags.map((k) => TEAM_TAGS.find((x) => x.key === k)?.label ?? k).join(', ')}` : ''));
      setEditing(null);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h">
        <div>
          <h3>Team coverage (admin)</h3>
          <div className="meta">Zones drive the geography suggestion · routing tags outrank it ·
            pick from the same area list the intake uses</div>
        </div>
        <button className="tbtn" onClick={() => { setOpen(!open); setEditing(null); setSaved(null); }}>
          {open ? 'Close' : 'Edit coverage'}</button>
      </div>
      {saved && (
        <div role="status" style={{ margin: '0 18px 12px', background: 'var(--accent-light)',
          color: 'var(--accent)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5, fontWeight: 600 }}>
          ✓ {saved}
        </div>
      )}
      {open && (
        <div className="scroll"><table className="bnl-table">
          <thead><tr><th>Team</th><th>Covers</th><th>Routing</th><th style={{ textAlign: 'right' }}></th></tr></thead>
          <tbody>
            {teams.map((t) => (
              <FragmentZoneRow key={t.id}>
                <tr style={{ cursor: 'default' }}>
                  <td className="bnl-nm" style={{ minWidth: 180 }}>{t.name}</td>
                  <td>{t.zones.length
                    ? t.zones.map((z) => <span key={z} className="bnl-fp bnl-fp-par">{z}</span>)
                    : <span className="bnl-sub">no zones — never suggested by geography</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.factors.length
                    ? t.factors.map((k) => <span key={k} className="bnl-fp bnl-fp-sch">
                        {TEAM_TAGS.find((x) => x.key === k)?.label ?? k}</span>)
                    : <span className="bnl-sub">—</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="tbtn" disabled={busy}
                      onClick={() => (editing === t.id ? setEditing(null) : startEdit(t))}>
                      {editing === t.id ? 'Cancel' : 'Edit'}</button>
                  </td>
                </tr>
                {editing === t.id ? (
                  <tr style={{ cursor: 'default' }}>
                    <td colSpan={4} style={{ background: 'var(--rowhover)' }}>
                      <div style={{ padding: '8px 6px 14px' }}>
                        <div className="bnl-sub" style={{ margin: '4px 0 6px', fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          Areas covered — tap to toggle ({zones.length} selected)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {AREAS.map((a) => {
                            const on = zones.includes(a);
                            return (
                              <button key={a} type="button" aria-pressed={on}
                                onClick={() => setZones((p) => on ? p.filter((x) => x !== a) : [...p, a])}
                                style={{ border: `1px solid ${on ? 'var(--secondary)' : 'var(--border)'}`,
                                  background: on ? 'var(--primary-light)' : 'var(--card)',
                                  color: on ? 'var(--strong)' : 'var(--muted)',
                                  borderRadius: 16, padding: '5px 11px', fontSize: 12,
                                  fontWeight: 600, cursor: 'pointer', font: 'inherit' }}>
                                {on ? '✓ ' : ''}{a}</button>
                            );
                          })}
                        </div>
                        <div className="bnl-sub" style={{ margin: '12px 0 6px', fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          Routing — this team takes these callers countywide</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {TEAM_TAGS.map(({ key, label }) => {
                            const on = tags.includes(key);
                            return (
                              <button key={key} type="button" aria-pressed={on}
                                onClick={() => setTags((p) => on ? p.filter((x) => x !== key) : [...p, key])}
                                style={{ border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                                  background: on ? 'var(--accent-light)' : 'var(--card)',
                                  color: on ? 'var(--strong)' : 'var(--muted)',
                                  borderRadius: 16, padding: '5px 11px', fontSize: 12,
                                  fontWeight: 600, cursor: 'pointer', font: 'inherit' }}>
                                {on ? '✓ ' : ''}{label}</button>
                            );
                          })}
                        </div>
                        <div style={{ marginTop: 12 }}>
                          <button className="btn primary" style={{ padding: '6px 16px', fontSize: 12.5 }}
                            disabled={busy || !dirty(t)} onClick={() => save(t)}>
                            {dirty(t) ? 'Save changes' : 'No changes'}</button>
                          <button className="tbtn" style={{ marginLeft: 8 }}
                            onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </FragmentZoneRow>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function FragmentZoneRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
