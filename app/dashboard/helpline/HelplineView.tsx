'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import { fmtInt } from '../../../lib/format';
import CaseMap from '../../../components/CaseMap';
import ReportMap from './ReportMap';
import { AREAS, COUNTY_ZONES, MAX_FAILED_ATTEMPTS, priorityBand, suggestTeam, type CaseStatus } from '../../../lib/helpline-options';
import { fetchCustomAreas } from '../../../lib/custom-areas';
import ReferOut, { type ReferralResource } from '../../../components/ReferOut';

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
  county_district: string | null;
  /** external resource this call was referred to (SOP refer-out; null unless
   *  status referred_out or an info-only referral was logged) */
  referred_to: string | null;
  matched_pid: string | null;
  confirmed_at: string | null;
  verified_entry: string | null;
  verified_proj: string | null;
}
export interface Team {
  id: number; name: string; project_id: number | null;
  zones: string[]; factors: string[]; active: boolean;
  /** field workers WITHOUT accounts + dispatch contact (free text, from the
   *  MHAP staffing doc; City district sub-teams carry these) */
  members?: string | null; dispatch?: string | null;
  /** dashboard ACCOUNTS assigned to the team — jsonb snapshot [{id,name}],
   *  admin-managed in TeamAdmin (run team_mgmt.sql once; undefined before) */
  member_accounts?: { id: string; name: string }[] | null;
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

// One color language with the call map (user directive 2026-08-20): red =
// awaiting action, green = being worked by outreach, blue = confirmed.
const STATUS_CHIP: Record<CaseStatus, [string, string, string]> = {
  new: ['new', 'var(--danger-light)', 'var(--danger)'],
  assigned: ['assigned', 'var(--accent-light)', 'var(--accent)'],
  attempted: ['attempted', 'var(--accent-light)', 'var(--accent)'],
  contacted: ['contacted', 'var(--accent-light)', 'var(--accent)'],
  confirmed: ['confirmed homeless', 'var(--info-light)', 'var(--info)'],
  declined: ['declined help', 'var(--track)', 'var(--muted)'],
  no_locate: ['could not locate', 'var(--track)', 'var(--muted)'],
  closed: ['closed', 'var(--track)', 'var(--muted)'],
  referred_out: ['referred out', 'var(--primary-light)', 'var(--secondary)'],
};
function Chip({ s }: { s: CaseStatus }) {
  const [label, bg, fg] = STATUS_CHIP[s];
  return <span className="bnl-chip" style={{ background: bg, color: fg }}>{label}</span>;
}

/** The date that MADE the current status — "contacted" with no date answers
 *  half the question (user catch). */
function statusDate(c: HlCase): string | null {
  switch (c.status) {
    case 'assigned': return c.assigned_at ? c.assigned_at.slice(0, 10) : null;
    case 'attempted': return c.last_attempt;
    case 'contacted': return c.last_contact;
    case 'confirmed': return c.confirmed_at;
    default: return null;
  }
}
function ChipDated({ c }: { c: HlCase }) {
  const d = statusDate(c);
  return <><Chip s={c.status} />{d && <div className="bnl-sub" style={{ marginTop: 2 }}>{d}</div>}</>;
}

const OPEN_STATUSES: CaseStatus[] = ['assigned', 'attempted', 'contacted'];

export default function HelplineView({ me, isAdmin, cases, teams, events = {}, sqlMissing }: {
  me: string; isAdmin: boolean; cases: HlCase[]; teams: Team[];
  /** outreach trail per open case: chronological attempt/contact events */
  events?: Record<number, { at: string; kind: string }[]>;
  sqlMissing: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [cands, setCands] = useState<Record<number, Candidate[] | 'loading'>>({});
  const [mapId, setMapId] = useState<number | null>(null);
  const [drawerC, setDrawerC] = useState<HlCase | null>(null);
  const [q, setQ] = useState('');
  // All-cases filters + sort (user ask 2026-08-19)
  const [fStatus, setFStatus] = useState('');
  const [fTeam, setFTeam] = useState('');           // '' all · 'none' · team id
  const [fEnroll, setFEnroll] = useState('');       // '' all · 'verified' · 'gap'
  const [sortKey, setSortKey] = useState<'name' | 'called' | 'team' | 'status' | 'trail' | 'enroll'>('called');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const setSort = (k: typeof sortKey) => {
    if (k === sortKey) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' || k === 'team' || k === 'status' ? 'asc' : 'desc'); }
  };

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

  // SOP refer-out from triage: terminal closes the case as referred_out;
  // info-only logs that the script was read but keeps the case in the queue
  // (an unsheltered caller in coverage still gets outreach). Either way the
  // "document that referral info was provided" note lands in the call log.
  const [referFor, setReferFor] = useState<HlCase | null>(null);
  const referOut = async (c: HlCase, r: ReferralResource, terminal: boolean) => {
    setReferFor(null);
    const ev = await db().from('helpline_calls').insert({
      case_id: c.id, operator: me, kind: 'followup',
      notes: terminal
        ? `Referred out → ${r.name}. SOP referral information provided to the caller.`
        : `Referral info provided → ${r.name}; case remains active for outreach.`,
    });
    if (ev.error) { setError(ev.error.message); return; }
    if (terminal) await update(c.id, { status: 'referred_out', referred_to: r.name });
    else router.refresh();
  };

  // Failed try and successful contact are SEPARATE facts (user call
  // 2026-08-19): each bumps its own counter, and status only moves FORWARD —
  // a failed try after a successful contact never downgrades the case.
  // 3-strike rule: the Nth failed attempt with zero successful contacts
  // auto-closes as no_locate (Reopen stays one click away).
  // Each ✗/✓ is an immutable EVENT (helpline_calls) so the board can show the
  // chronology — which try succeeded, not just how many (user catch). The
  // counters stay for auto-close math and the reporting table.
  const logAttempt = async (c: HlCase) => {
    const attempts = c.attempts + 1;
    const strikeOut = attempts >= MAX_FAILED_ATTEMPTS && (c.contacts ?? 0) === 0
      && ['assigned', 'attempted'].includes(c.status);
    const ev = await db().from('helpline_calls').insert({ case_id: c.id, operator: me, kind: 'attempt' });
    if (ev.error) setError(`Per-try event not recorded (re-run supabase/helpline.sql): ${ev.error.message}`);
    return update(c.id, {
      status: strikeOut ? 'no_locate' : c.status === 'assigned' ? 'attempted' : c.status,
      attempts,
      last_attempt: new Date().toISOString().slice(0, 10),
    });
  };

  const logContact = async (c: HlCase) => {
    const ev = await db().from('helpline_calls').insert({ case_id: c.id, operator: me, kind: 'contact' });
    if (ev.error) setError(`Per-try event not recorded (re-run supabase/helpline.sql): ${ev.error.message}`);
    return update(c.id, {
      status: ['assigned', 'attempted'].includes(c.status) ? 'contacted' : c.status,
      contacts: (c.contacts ?? 0) + 1,
      last_contact: new Date().toISOString().slice(0, 10),
    });
  };

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
  const done = cases.filter((c) => ['declined', 'no_locate', 'closed', 'referred_out'].includes(c.status));
  const referredOut = cases.filter((c) => c.status === 'referred_out');
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
        <button className="bnl-nm" onClick={() => setDrawerC(c)}
          title="Open the case drawer — full details, notes, and history"
          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
            cursor: 'pointer', textDecoration: 'underline dotted',
            textUnderlineOffset: 3, color: 'var(--strong)' }}>{nameOf(c)}</button>{' '}
        <b style={{ color: bandColor(band), fontSize: 11 }}>{band}</b>
        <div className="bnl-sub" style={{ lineHeight: 1.6 }}>
          {c.area ?? 'area unknown'}{c.county_district ? ` · ${c.county_district}` : ''}{c.address ? ` · ${c.address}` : ''}{c.landmark ? ` · ${c.landmark}` : ''}
          {c.sleeping ? ` · ${c.sleeping}` : ''}{c.household && c.household !== 'Alone' ? ` · ${c.household}` : ''}
          {c.factors.length > 0 && <> · {c.factors.join(', ')}</>}
          {(c.phone_callback || c.phone_line) && <> · ☎ {c.phone_callback ?? c.phone_line}</>}
          {c.referred_to && <> · ↗ {c.referred_to}</>}
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
            disabled={busy} title={`Suggested: ${sug.why} — ${openByTeam.get(sug.team.id) ?? 0} open cases`}
            onClick={() => assign(c, sug.team.id)}>
            Assign → {sug.team.name.length > 26 ? `${sug.team.name.slice(0, 24)}…` : sug.team.name}
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
        <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
          title="SOP refer-out (prevention · veterans · DV · youth · other-provider areas) — shows the script first"
          onClick={() => setReferFor(c)}>↗ Refer</button>
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
          'var(--danger)')}
        {kpi('With outreach', working.length, 'assigned · attempted · contacted', 'var(--accent)')}
        {kpi('Confirmed homeless', confirmed.length,
          `${fmtInt(verified.length)} verified enrolled · ${fmtInt(unverified.length)} pending`, 'var(--info)')}
        {kpi('Enrollment gap', unverified.length,
          unverified.length ? 'confirmed but no HMIS enrollment yet' : 'everyone confirmed is enrolled', 'var(--danger)')}
        {kpi('Referred out', referredOut.length,
          'prevention · veterans · DV · youth — right-door diversions', 'var(--secondary)')}
        {kpi('All cases', cases.length, `${fmtInt(done.length)} closed/other`, 'var(--faint)')}
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Triage queue</h3>
            <div className="meta">New calls, highest priority first · suggestion = factors → area → county district · fewest open cases breaks ties</div>
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
              {team.zones.length ? ` · covers ${team.zones.join(', ')}` : ' · no zones set'}
              {(() => {
                const staff = [...(team.member_accounts ?? []).map((a) => a.name),
                  team.members ?? ''].filter(Boolean).join(', ');
                return staff ? ` · ${staff}` : '';
              })()}
              {team.dispatch ? ` · dispatch: ${team.dispatch}` : ''}</span>
            </div>
            <div className="scroll"><table className="bnl-table">
              <thead><tr><th>Case</th><th>Status</th><th>Outreach trail</th>
                <th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {working.filter((c) => c.team_id === team.id).map((c) => (
                  <FragmentZoneRow key={c.id}>
                  <tr style={{ cursor: 'default' }}>
                    <CaseCell c={c} />
                    <td style={{ whiteSpace: 'nowrap' }}><ChipDated c={c} /></td>
                    <td><Trail events={events[c.id]} c={c} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {(c.lat != null || c.address || c.landmark) && (
                        <button className="tbtn" style={{ marginRight: 6 }}
                          title="Show where to find them — location details + map, right here"
                          onClick={() => setMapId(mapId === c.id ? null : c.id)}>
                          {mapId === c.id ? 'Hide map' : '📍 Map'}</button>
                      )}
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
                  {mapId === c.id ? (
                    <tr style={{ cursor: 'default' }}>
                      <td colSpan={4} style={{ background: 'var(--rowhover)' }}>
                        <div style={{ padding: '8px 6px 14px' }}>
                          <div style={{ marginBottom: 8, fontSize: 13 }}>
                            <b style={{ color: 'var(--strong)' }}>{c.address || c.landmark || c.area || 'No location captured'}</b>
                            <div className="bnl-sub" style={{ lineHeight: 1.6 }}>
                              {c.address && c.landmark && <>{c.landmark} · </>}
                              {c.area && <>{c.area} · </>}
                              {c.lat != null && c.lng != null && <>{c.lat.toFixed(5)}, {c.lng.toFixed(5)} · </>}
                              <a style={{ color: 'var(--secondary)' }} target="_blank" rel="noreferrer"
                                href={c.lat != null && c.lng != null
                                  ? `https://maps.google.com/?q=${c.lat},${c.lng}`
                                  : `https://maps.google.com/?q=${encodeURIComponent(`${c.address ?? c.landmark}, ${c.area ?? ''} FL`)}`}>
                                Open in Google Maps →</a>
                            </div>
                          </div>
                          {c.lat != null && c.lng != null
                            ? <CaseMap lat={c.lat} lng={c.lng} zoom={17} width={640} height={280} />
                            : <div className="bnl-sub">No coordinates on this case — the address above is
                                all we have. Use 📍 Locate on intake to add a pin.</div>}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </FragmentZoneRow>
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
            <div className="meta">Confirmed cases verify against each HMIS export — the
              <b style={{ color: 'var(--danger)' }}> enrollment gap</b> list is the one to watch</div>
          </div>
          <input className="finput" placeholder="Search name, phone, area, notes…"
            value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }}
            aria-label="Search cases" />
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '0 18px 10px' }}>
          <div className="fgroup"><span className="flabel">Status</span>
            <select className="fselect" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">All</option>
              <option value="confirmed">Confirmed homeless</option>
              <option value="referred_out">Referred out</option>
              <option value="no_locate">Could not locate</option>
              <option value="declined">Declined help</option>
              <option value="closed">Closed</option>
            </select></div>
          <div className="fgroup"><span className="flabel">Team</span>
            <select className="fselect" value={fTeam} onChange={(e) => setFTeam(e.target.value)}>
              <option value="">All</option>
              <option value="none">(never assigned)</option>
              {teams.map((x) => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
            </select></div>
          <div className="fgroup"><span className="flabel">Enrollment</span>
            <select className="fselect" value={fEnroll} onChange={(e) => setFEnroll(e.target.value)}>
              <option value="">All</option>
              <option value="verified">✓ Verified enrolled</option>
              <option value="gap">⚠ Enrollment gap</option>
            </select></div>
        </div>
        <div className="scroll"><table className="bnl-table">
          <thead><tr>
            {([['name', 'Caller'], ['called', 'Called'], ['team', 'Team'], ['status', 'Status'],
               ['trail', 'Outreach trail'], ['enroll', 'Enrollment']] as const).map(([k, lbl]) => (
              <th key={k} onClick={() => setSort(k)} title="Click to sort"
                className={sortKey === k ? 'sorted' : undefined} style={{ cursor: 'pointer' }}>
                {lbl}{sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
            <th style={{ textAlign: 'right' }}></th>
          </tr></thead>
          <tbody>
            {(() => {
              const teamName = (c: HlCase) => c.team_id != null ? (teamById.get(c.team_id)?.name ?? '') : '';
              const trailN = (c: HlCase) => (events[c.id]?.length ?? 0) || c.attempts + (c.contacts ?? 0);
              // enrollment rank: gap (worst, aging first) < n/a < verified
              const enrollVal = (c: HlCase) => c.status !== 'confirmed' ? 1
                : c.verified_entry ? 2 : 0;
              const cmp = (a: HlCase, b: HlCase): number => {
                switch (sortKey) {
                  case 'name': return nameOf(a).localeCompare(nameOf(b));
                  case 'called': return a.created_at.localeCompare(b.created_at);
                  case 'team': return teamName(a).localeCompare(teamName(b));
                  case 'status': return a.status.localeCompare(b.status);
                  case 'trail': return trailN(a) - trailN(b);
                  case 'enroll': return enrollVal(a) - enrollVal(b)
                    || (a.confirmed_at ?? '').localeCompare(b.confirmed_at ?? '');
                }
              };
              return [...confirmed, ...done]
                .filter((c) => !t || searchable(c).includes(t))
                .filter((c) => !fStatus || c.status === fStatus)
                .filter((c) => !fTeam || (fTeam === 'none' ? c.team_id == null : c.team_id === Number(fTeam)))
                .filter((c) => !fEnroll
                  || (fEnroll === 'verified' && Boolean(c.verified_entry))
                  || (fEnroll === 'gap' && c.status === 'confirmed' && !c.verified_entry))
                .sort((a, b) => sortDir === 'asc' ? cmp(a, b) : cmp(b, a));
            })().map((c) => (
              <tr key={c.id} style={{ cursor: 'default' }}>
                <CaseCell c={c} />
                <td style={{ whiteSpace: 'nowrap' }}>{when(c.created_at)}</td>
                <td>{c.team_id != null ? (teamById.get(c.team_id)?.name ?? '?') : '—'}</td>
                <td><ChipDated c={c} /></td>
                <td>
                  {/* full ✗/✓ chronology — how hard was this case worked */}
                  {c.attempts > 0 || (c.contacts ?? 0) > 0 || events[c.id]?.length
                    ? <Trail events={events[c.id]} c={c} />
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
                  {['no_locate', 'declined', 'closed', 'referred_out'].includes(c.status) && (
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

      <ReportMap cases={cases} teams={teams} isAdmin={isAdmin} onOpen={(c) => setDrawerC(c)} />

      {drawerC && (
        <CaseDrawer c={cases.find((x) => x.id === drawerC.id) ?? drawerC}
          teamName={drawerC.team_id != null ? (teamById.get(drawerC.team_id)?.name ?? null) : null}
          events={events[drawerC.id]} me={me} onClose={() => setDrawerC(null)} />
      )}

      {referFor && (
        <ReferOut title={`Refer #${referFor.id} out`}
          onPick={(r, terminal) => referOut(referFor, r, terminal)}
          onClose={() => setReferFor(null)} />
      )}

      <Reporting cases={cases} teams={teams} events={events} />

      {isAdmin && <TeamAdmin teams={teams} busy={busy}
        onCreate={(name) => run(async () => db().from('outreach_teams')
          .insert({ name, zones: [], factors: [] }))}
        onSave={(id, patch) => run(async () => db().from('outreach_teams')
          .update(patch).eq('id', id))} />}
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

/** Chronological ✗/✓ trail — answers "which try succeeded", not just how
 *  many. Falls back to the counters for cases logged before events existed. */
function Trail({ events, c }: { events?: { at: string; kind: string }[]; c: HlCase }) {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  if (events?.length) {
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 5 }}>
        {events.map((e, i) => (
          <span key={i} className="bnl-fp" style={e.kind === 'contact'
            ? { background: 'var(--accent-light)', color: 'var(--accent)' }
            : { background: 'var(--danger-light)', color: 'var(--danger)' }}
            title={e.kind === 'contact' ? `Successful contact — try #${i + 1}` : `Failed attempt #${i + 1}`}>
            {e.kind === 'contact' ? '✓' : '✗'} {fmt(e.at)}
          </span>
        ))}
      </span>
    );
  }
  // Pre-events fallback: this case was worked before per-try tracking, so
  // only totals exist. Say so instead of looking half-broken — and when the
  // status implies a contact that was never date-stamped, admit that too.
  const impliedContact = (c.contacts ?? 0) === 0
    && ['contacted', 'confirmed'].includes(c.status);
  if (c.attempts > 0 || (c.contacts ?? 0) > 0 || impliedContact) {
    return (
      <span className="bnl-sub" title="Worked before per-try tracking (2026-08-19) — new ✗/✓ clicks record individual dated events">
        {c.attempts > 0 && <>✗ ×{c.attempts}{c.last_attempt ? ` (last ${c.last_attempt})` : ''}</>}
        {c.attempts > 0 && ((c.contacts ?? 0) > 0 || impliedContact) && ' · '}
        {(c.contacts ?? 0) > 0 && <span style={{ color: 'var(--accent)' }}>
          ✓ ×{c.contacts}{c.last_contact ? ` (last ${c.last_contact})` : ''}</span>}
        {impliedContact && <span style={{ color: 'var(--accent)' }}>✓ contacted, date not recorded</span>}
        <span> · pre-tracking totals</span>
      </span>
    );
  }
  return <span className="bnl-sub">no outreach yet</span>;
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
function Reporting({ cases, teams, events }: {
  cases: HlCase[]; teams: Team[]; events: Record<number, { at: string; kind: string }[]>;
}) {
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
      // Assignment → FIRST outreach action (✗ or ✓, whichever came first).
      // Needs per-try events, so pre-tracking cases don't contribute.
      const firstTryHrs = list
        .filter((c) => c.assigned_at && events[c.id]?.length)
        .map((c) => (new Date(events[c.id][0].at).getTime() - new Date(c.assigned_at!).getTime()) / 3_600_000)
        .filter((h) => h >= 0);
      const avgFirstTry = firstTryHrs.length
        ? firstTryHrs.reduce((a, b) => a + b, 0) / firstTryHrs.length : null;
      return {
        label,
        total: list.length,
        open: list.filter((c) => OPEN_STATUSES.includes(c.status)).length,
        confirmed: list.filter((c) => c.status === 'confirmed').length,
        enrolled: list.filter((c) => c.verified_entry).length,
        noLocate: list.filter((c) => c.status === 'no_locate').length,
        declined: list.filter((c) => c.status === 'declined').length,
        medAssign: median(assignHrs),
        avgFirstTry,
        firstTryN: firstTryHrs.length,
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
      'no_locate', 'declined', 'median_hours_to_assignment',
      'avg_hours_assignment_to_first_try', 'first_try_sample_n'];
    const body = rows.map((r) => [r.label, r.total, r.open, r.confirmed, r.enrolled,
      r.noLocate, r.declined, r.medAssign == null ? '' : r.medAssign.toFixed(1),
      r.avgFirstTry == null ? '' : r.avgFirstTry.toFixed(1), r.firstTryN].map(esc).join(','));
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
      {(() => {
        // SOP external referrals — the diversion tally by destination
        const ro = cases.filter((c) => c.status === 'referred_out');
        if (!ro.length) return null;
        const by = new Map<string, number>();
        ro.forEach((c) => by.set(c.referred_to ?? '(unspecified)', (by.get(c.referred_to ?? '(unspecified)') ?? 0) + 1));
        return (
          <div className="bnl-sub" style={{ padding: '0 18px 10px' }}>
            ↗ External referrals: {[...by.entries()].sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k} — ${v}`).join(' · ')}
          </div>
        );
      })()}
      <div className="scroll"><table className="bnl-table">
        <thead><tr>
          <th>Team</th><th className="num">Cases</th><th className="num">Open now</th>
          <th className="num">Confirmed</th><th className="num">Enrolled ✓</th>
          <th className="num">No-locate</th><th className="num">Declined</th>
          <th className="num">Call → assigned</th>
          <th className="num" title="Average time from team assignment to the FIRST outreach action (failed or successful) — per-try tracking only, so pre-upgrade cases don't count">
            Assigned → 1st try (avg)</th>
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
              <td className="num">{r.avgFirstTry == null ? <span className="bnl-sub">—</span>
                : <>{r.avgFirstTry < 1 ? `${Math.round(r.avgFirstTry * 60)}m`
                    : r.avgFirstTry < 48 ? `${r.avgFirstTry.toFixed(1)}h`
                    : `${(r.avgFirstTry / 24).toFixed(1)}d`}
                    <span className="bnl-sub"> · n={r.firstTryN}</span></>}</td>
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
 * Admin-only team management (user ask 2026-08-20): create teams, assign
 * DASHBOARD ACCOUNTS to them (member_accounts jsonb snapshot [{id,name}] —
 * cohort_tasks.assignees precedent, because profiles are self-read-only for
 * non-admins, so the board can't join names at read time), name field workers
 * without accounts (free-text `members`, the MHAP staffing doc), set the
 * dispatch contact, activate/deactivate, and cover zones. Zones are TAP-CHIPS
 * — a typed "hialeah" can never miss "Hialeah" because nothing is typed.
 * Saving is explicit: the button only lights up when something changed, and a
 * confirmation names exactly what was saved. Requires supabase/team_mgmt.sql
 * for the accounts column + admin-only writes; degrades gracefully before it.
 */
function TeamAdmin({ teams, busy, onCreate, onSave }: {
  teams: Team[]; busy: boolean;
  onCreate: (name: string) => Promise<boolean>;
  onSave: (id: number, patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [name, setName] = useState('');
  const [zones, setZones] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [accts, setAccts] = useState<{ id: string; name: string }[]>([]);
  const [fieldTxt, setFieldTxt] = useState('');
  const [dispatchTxt, setDispatchTxt] = useState('');
  const [activeFlag, setActiveFlag] = useState(true);

  // Approved accounts for the assignment picker — lazy, once per panel open.
  // The admin's own session reads profiles (admins-read-all policy).
  const [accounts, setAccounts] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!open || accounts !== null) return;
    (async () => {
      const { data } = await supabaseBrowser().from('profiles')
        .select('id, display_name, email').eq('status', 'approved').order('display_name');
      setAccounts((data ?? []).map((p: any) => ({
        id: String(p.id),
        name: String(p.display_name || p.email || String(p.id).slice(0, 8)),
      })));
    })();
  }, [open, accounts]);
  // Custom-area names drawn on the call map — offered as zone chips (names
  // already in AREAS are filtered: their chip exists in the main group).
  const [customZones, setCustomZones] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open || customZones !== null) return;
    fetchCustomAreas().then((as) => setCustomZones(
      as.map((a) => a.name).filter((n) => !(AREAS as readonly string[]).includes(n))));
  }, [open, customZones]);

  const idsOf = (xs: { id: string }[]) => JSON.stringify(xs.map((a) => a.id).sort());
  const startEdit = (t: Team) => {
    setEditing(t.id);
    setName(t.name);
    setZones([...t.zones]);
    setTags([...t.factors]);
    setAccts([...(t.member_accounts ?? [])]);
    setFieldTxt(t.members ?? '');
    setDispatchTxt(t.dispatch ?? '');
    setActiveFlag(t.active);
    setSaved(null);
  };
  const dirty = (t: Team) =>
    name.trim() !== t.name
    || JSON.stringify([...zones].sort()) !== JSON.stringify([...t.zones].sort())
    || JSON.stringify([...tags].sort()) !== JSON.stringify([...t.factors].sort())
    || idsOf(accts) !== idsOf(t.member_accounts ?? [])
    || fieldTxt.trim() !== (t.members ?? '')
    || dispatchTxt.trim() !== (t.dispatch ?? '')
    || activeFlag !== t.active;

  async function save(t: Team) {
    const patch: Record<string, unknown> = {
      name: name.trim() || t.name,
      zones,
      factors: tags,
      active: activeFlag,
    };
    // Columns from later run-once SQL (helpline.sql tail: members/dispatch;
    // team_mgmt.sql: member_accounts) are sent ONLY when changed — confirmed
    // 2026-08-20 that prod predates them, and an unknown column fails the
    // whole update.
    if (fieldTxt.trim() !== (t.members ?? '')) patch.members = fieldTxt.trim() || null;
    if (dispatchTxt.trim() !== (t.dispatch ?? '')) patch.dispatch = dispatchTxt.trim() || null;
    if (idsOf(accts) !== idsOf(t.member_accounts ?? [])) patch.member_accounts = accts;
    const ok = await onSave(t.id, patch);
    if (ok) {
      setSaved(`Saved — ${patch.name} covers ${zones.length ? zones.join(', ') : 'no areas'}`
        + (accts.length ? ` · staff ${accts.map((a) => a.name).join(', ')}` : '')
        + (tags.length ? ` · routes ${tags.map((k) => TEAM_TAGS.find((x) => x.key === k)?.label ?? k).join(', ')}` : '')
        + (activeFlag ? '' : ' · INACTIVE'));
      setEditing(null);
    }
  }

  async function create() {
    const nm = newName.trim();
    if (!nm) return;
    const ok = await onCreate(nm);
    if (ok) {
      setNewName('');
      setSaved(`Team created — ${nm}. It appears below once the page refreshes; Edit it to assign staff and coverage.`);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h">
        <div>
          <h3>Teams (admin)</h3>
          <div className="meta">Create teams, assign staff, set coverage · zones drive the geography
            suggestion — city districts + county districts are auto-detected from the call pin ·
            routing tags outrank geography</div>
        </div>
        <button className="tbtn" onClick={() => { setOpen(!open); setEditing(null); setSaved(null); }}>
          {open ? 'Close' : 'Manage teams'}</button>
      </div>
      {saved && (
        <div role="status" style={{ margin: '0 18px 12px', background: 'var(--accent-light)',
          color: 'var(--accent)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5, fontWeight: 600 }}>
          ✓ {saved}
        </div>
      )}
      {open && (
        <div style={{ display: 'flex', gap: 8, padding: '0 18px 12px' }}>
          <input className="tinput" style={{ maxWidth: 320 }} value={newName} maxLength={80}
            placeholder="New team name — e.g. MHAP North"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <button className="btn primary" style={{ padding: '6px 14px', fontSize: 12.5 }}
            disabled={busy || !newName.trim()} onClick={create}>＋ Create team</button>
        </div>
      )}
      {open && (
        <div className="scroll"><table className="bnl-table">
          <thead><tr><th>Team</th><th>Staff</th><th>Covers</th><th>Routing</th><th style={{ textAlign: 'right' }}></th></tr></thead>
          <tbody>
            {teams.map((t) => (
              <FragmentZoneRow key={t.id}>
                <tr style={{ cursor: 'default', opacity: t.active ? 1 : 0.55 }}>
                  <td className="bnl-nm" style={{ minWidth: 180 }}>{t.name}
                    {!t.active && <span className="bnl-sub"> · inactive</span>}</td>
                  <td>
                    {(t.member_accounts?.length || t.members)
                      ? <span style={{ fontSize: 12.5 }}>
                          {(t.member_accounts ?? []).map((a) => (
                            <span key={a.id} className="bnl-fp bnl-fp-sch">{a.name}</span>))}
                          {t.members && <span className="bnl-sub"> {t.members}</span>}
                        </span>
                      : <span className="bnl-sub">—</span>}
                  </td>
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
                    <td colSpan={5} style={{ background: 'var(--rowhover)' }}>
                      <div style={{ padding: '8px 6px 14px' }}>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div className="bnl-sub" style={{ margin: '4px 0 6px', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '.05em' }}>Team name</div>
                            <input className="tinput" style={{ width: '100%' }} value={name} maxLength={80}
                              onChange={(e) => setName(e.target.value)} />
                          </div>
                          <div style={{ flex: 1, minWidth: 220 }}>
                            <div className="bnl-sub" style={{ margin: '4px 0 6px', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '.05em' }}>
                              Dispatch contact — phone/email for the sheet</div>
                            <input className="tinput" style={{ width: '100%' }} value={dispatchTxt} maxLength={120}
                              onChange={(e) => setDispatchTxt(e.target.value)} />
                          </div>
                        </div>
                        <div className="bnl-sub" style={{ margin: '12px 0 6px', fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          Staff accounts — tap to assign ({accts.length} assigned)</div>
                        {accounts === null && <div className="bnl-sub">Loading accounts…</div>}
                        {accounts !== null && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {accounts.map((a) => {
                              const on = accts.some((x) => x.id === a.id);
                              return (
                                <button key={a.id} type="button" aria-pressed={on}
                                  onClick={() => setAccts((p) => on
                                    ? p.filter((x) => x.id !== a.id) : [...p, a])}
                                  style={{ border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                                    background: on ? 'var(--accent-light)' : 'var(--card)',
                                    color: on ? 'var(--strong)' : 'var(--muted)',
                                    borderRadius: 16, padding: '5px 11px', fontSize: 12,
                                    fontWeight: 600, cursor: 'pointer', font: 'inherit' }}>
                                  {on ? '✓ ' : ''}{a.name}</button>
                              );
                            })}
                          </div>
                        )}
                        <div className="bnl-sub" style={{ margin: '12px 0 6px', fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '.05em' }}>
                          Field workers without accounts — free text, shows on the board and the sheet</div>
                        <input className="tinput" style={{ width: '100%' }} value={fieldTxt} maxLength={300}
                          placeholder="e.g. J. Perez · M. Charles"
                          onChange={(e) => setFieldTxt(e.target.value)} />
                        <div className="bnl-sub" style={{ margin: '12px 0 6px', fontWeight: 700,
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
                          County Commission Districts — fallback when no team covers the specific
                          area (auto-stamped on the case from the call&rsquo;s pin)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {COUNTY_ZONES.map((a) => {
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
                        {(customZones?.length ?? 0) > 0 && (
                          <>
                            <div className="bnl-sub" style={{ margin: '12px 0 6px', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '.05em' }}>
                              Custom areas — drawn on the call map</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {customZones!.map((a) => {
                                const on = zones.includes(a);
                                return (
                                  <button key={a} type="button" aria-pressed={on}
                                    onClick={() => setZones((p) => on ? p.filter((x) => x !== a) : [...p, a])}
                                    style={{ border: `1px solid ${on ? 'var(--info)' : 'var(--border)'}`,
                                      background: on ? 'var(--info-light)' : 'var(--card)',
                                      color: on ? 'var(--strong)' : 'var(--muted)',
                                      borderRadius: 16, padding: '5px 11px', fontSize: 12,
                                      fontWeight: 600, cursor: 'pointer', font: 'inherit' }}>
                                    {on ? '✓ ' : ''}{a}</button>
                                );
                              })}
                            </div>
                          </>
                        )}
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
                        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12,
                          fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={activeFlag}
                            onChange={(e) => setActiveFlag(e.target.checked)} />
                          Active — inactive teams keep their case history but leave every picker and
                          the suggestion engine
                        </label>
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


/**
 * Case drawer — the whole record in one overlay (BNL drawer pattern): who,
 * where (with map), situation, assignment, outreach trail, enrollment
 * verification, and the full call log with an append-only note composer
 * (notes are immutable helpline_calls events, same rule as BNL notes).
 */
function CaseDrawer({ c, teamName, events, me, onClose }: {
  c: HlCase; teamName: string | null;
  events?: { at: string; kind: string }[];
  me: string; onClose: () => void;
}) {
  const [log, setLog] = useState<{ received_at: string; kind: string; notes: string | null }[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const { data } = await supabaseBrowser().from('helpline_calls')
      .select('received_at, kind, notes')
      .eq('case_id', c.id)
      .order('received_at', { ascending: false })
      .limit(50);
    setLog((data ?? []) as any);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLog(null); load(); }, [c.id]);

  async function addNote() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true); setErr(null);
    const { error } = await supabaseBrowser().from('helpline_calls')
      .insert({ case_id: c.id, operator: me, kind: 'followup', notes: text });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setBody('');
    load();
  }

  const band = priorityBand(c.priority);
  const stamp = (iso: string) => new Date(iso).toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const KIND_LBL: Record<string, string> = {
    initial: '☎ initial call', followup: '📝 note / call-back',
    attempt: '✗ contact attempt (failed)', contact: '✓ contacted',
  };
  const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '2px 14px', fontSize: 13 }}>
      <span className="bnl-sub" style={{ paddingTop: 2 }}>{k}</span>
      <span style={{ color: 'var(--text)' }}>{children}</span>
    </div>
  );

  return (
    <div className="bnl-ov" onClick={onClose}>
      <div className="bnl-modal" onClick={(e) => e.stopPropagation()} role="dialog"
        aria-label={`Case ${c.id}`} style={{ maxWidth: 820 }}>
        <button className="bnl-x" onClick={onClose} aria-label="Close">✕</button>
        <h3>#{c.id} {nameOf(c)}{' '}
          <b style={{ color: bandColor(band), fontSize: 13 }}>{band}</b></h3>
        <div style={{ margin: '4px 0 10px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <ChipDated c={c} />
          <span className="bnl-sub">called {stamp(c.created_at)}</span>
          {teamName && <span className="bnl-fp bnl-fp-par">{teamName}</span>}
          <span style={{ flex: 1 }} />
          <Link className="tbtn" href={`/dashboard/helpline/print/${c.id}`} target="_blank">🖨 Sheet</Link>
          {c.matched_pid && (
            <Link className="tbtn" href={`/dashboard/bnl?pid=${encodeURIComponent(c.matched_pid)}`}>BNL →</Link>
          )}
        </div>

        <div style={{ display: 'grid', gap: 3 }}>
          <Row k="Reach them">
            <b>{c.phone_callback || c.phone_line || '—'}</b>
            {c.phone_callback && c.phone_line && c.phone_callback !== c.phone_line && (
              <span className="bnl-sub"> · called from {c.phone_line}</span>
            )}
          </Row>
          {(c.dob || c.ssn4) && (
            <Row k="Identity">{c.dob ?? ''}{c.dob && c.ssn4 ? ' · ' : ''}{c.ssn4 ? `SSN-4 ${c.ssn4}` : ''}</Row>
          )}
          <Row k="Location">
            {[c.address, c.landmark, c.area].filter(Boolean).join(' · ') || '—'}
            {c.lat != null && c.lng != null && (
              <a style={{ color: 'var(--secondary)', marginLeft: 6 }} target="_blank" rel="noreferrer"
                href={`https://maps.google.com/?q=${c.lat},${c.lng}`}>Google Maps →</a>
            )}
          </Row>
          <Row k="Situation">
            {[c.sleeping, c.household, ...(c.factors ?? [])].filter(Boolean).join(' · ') || '—'}
            <span className="bnl-sub"> · priority {c.priority} pts</span>
          </Row>
          {c.referred_to && <Row k="Referred to">↗ {c.referred_to}</Row>}
          {c.matched_pid && <Row k="HMIS">record {c.matched_pid.slice(0, 12)}…</Row>}
          <Row k="Outreach">
            <Trail events={events} c={c} />
          </Row>
          {c.status === 'confirmed' && (
            <Row k="Enrollment">
              {c.verified_entry
                ? <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                    ✓ enrolled {c.verified_entry} — {c.verified_proj}</span>
                : <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                    not enrolled yet — confirmed {c.confirmed_at}</span>}
            </Row>
          )}
        </div>

        {c.lat != null && c.lng != null && (
          <div style={{ marginTop: 10 }}>
            <CaseMap lat={c.lat} lng={c.lng} zoom={17} width={760} height={240} />
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <div className="bnl-sub" style={{ fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.05em', marginBottom: 6 }}>Log &amp; notes</div>
          {err && <div className="lerror" role="alert" style={{ marginBottom: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input className="tinput" style={{ flex: 1 }} value={body} maxLength={2000}
              placeholder="Add a note to this case — saved to the permanent log"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
            <button className="btn primary" disabled={busy || !body.trim()} onClick={addNote}>
              {busy ? 'Saving…' : 'Add note'}</button>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {log === null && <div className="bnl-sub">Loading log…</div>}
            {log?.map((k, i) => (
              <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--hair)' }}>
                <span className="bnl-sub">{stamp(k.received_at)} · {KIND_LBL[k.kind] ?? k.kind}</span>
                {k.notes && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{k.notes}</div>}
              </div>
            ))}
            {log?.length === 0 && <div className="bnl-sub">No log entries yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
