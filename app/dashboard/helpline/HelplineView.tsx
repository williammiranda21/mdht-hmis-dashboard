'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../../lib/supabase-browser';
import { fmtInt } from '../../../lib/format';
import CaseMap from '../../../components/CaseMap';
import ReportMap from './ReportMap';
import { AREAS, COUNTY_ZONES, DEFAULT_RULES, EMERGENCY_SLEEPING, FACTORS, HOUSEHOLD_OPTIONS,
  MAX_FAILED_ATTEMPTS, SLEEPING_OPTIONS, agingPts, priorityBand, priorityOf, suggestTeam,
  type CaseStatus, type PriorityRules } from '../../../lib/helpline-options';
import { fetchPriorityRules, invalidatePriorityRules } from '../../../lib/priority-rules';
import { inFeature, project, type GeoFC } from '../../../lib/slippy';
import { fetchCustomAreas } from '../../../lib/custom-areas';
import ReferOut, { type ReferralResource } from '../../../components/ReferOut';
import { CopyId } from '../analytics/shared';
import QrShare from '../../../components/QrShare';
import { TeamMenu, TeamMultiSelect, type TeamOpt } from '../../../components/TeamMenu';
import { IconPrinter, IconDownload, IconSmartphone, IconSearch, IconMapPin, IconHome } from '../../../components/icons';

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
  /** intake follow-up when household = 'With children'
   *  (helpline_household.sql; undefined before it runs) */
  household_size?: number | null;
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
  /** admin pin-to-top (helpline_priority.sql; undefined before it runs) */
  pinned?: boolean | null;
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
/** "4h" under a day, then "1d 4h" (user 2026-09-15: 28h was unreadable). */
function fmtHours(h: number): string {
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`;
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

// One color language with the call map (user directive 2026-09-22, supersedes
// 8/20): red = awaiting action, BLUE = being worked by outreach,
// GREEN = confirmed.
const STATUS_CHIP: Record<CaseStatus, [string, string, string]> = {
  new: ['new', 'var(--danger-light)', 'var(--danger)'],
  assigned: ['assigned', 'var(--info-light)', 'var(--info)'],
  attempted: ['attempted', 'var(--info-light)', 'var(--info)'],
  contacted: ['contacted', 'var(--info-light)', 'var(--info)'],
  confirmed: ['confirmed homeless', 'var(--accent-light)', 'var(--accent)'],
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
/** Days since a date-ish string; null when absent/unparseable. */
function daysSince(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s.length <= 10 ? `${s}T00:00:00` : s).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function ChipDated({ c }: { c: HlCase }) {
  const d = statusDate(c);
  // "How long has this client been sitting here?" (user 2026-09-02) — days
  // since the CALL came in, shown until outreach reaches them. Amber at 3d,
  // red at 7d. Once contacted the waiting question is answered, so it hides.
  const wait = (c.contacts ?? 0) === 0 && (c.status === 'assigned' || c.status === 'attempted')
    ? daysSince(c.created_at) : null;
  const wc = wait == null ? null : wait >= 7 ? 'var(--danger)' : wait >= 3 ? 'var(--warn)' : 'var(--muted)';
  return (
    <>
      <Chip s={c.status} />
      {wait != null && (
        <div style={{ marginTop: 3, fontSize: 11, fontWeight: 700, color: wc! }}
          title={`Called ${c.created_at.slice(0, 10)} — no successful contact yet`}>
          ⏳ waiting {wait === 0 ? '<1' : wait}d
        </div>
      )}
      {d && <div className="bnl-sub" style={{ marginTop: 2 }}>{d}</div>}
      {c.status === 'referred_out' && c.referred_to && (
        <div className="bnl-sub" style={{ marginTop: 2, maxWidth: 190, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`Referred to ${c.referred_to}`}>
          → {c.referred_to}
        </div>
      )}
    </>
  );
}

const OPEN_STATUSES: CaseStatus[] = ['assigned', 'attempted', 'contacted'];

/** Page sections as tabs (user-approved mockup 2026-08-20): operators live in
 *  the queue, dispatchers in the board, supervisors in map+reporting — each
 *  gets a focused screen. KPI cards stay above the tabs, counts ride on the
 *  tab labels so nothing hides, and the choice is remembered per person. */
type HlTab = 'queue' | 'board' | 'cases' | 'map' | 'admin';
const HL_TAB_KEY = 'hl-tab';

/* stroke icons for the section tabs (feather-style, match the sidebar) */
const PHONE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.08 4.18 2 2 0 0 1 4.06 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.68 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.32 1.85.55 2.81.68A2 2 0 0 1 22 16.92z"/></svg>
);
const HL_TAB_ICONS: Record<HlTab, React.ReactNode> = {
  queue: PHONE_ICON,
  board: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="5" height="14" rx="1"/><rect x="10" y="3" width="5" height="10" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>
  ),
  cases: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
  ),
  map: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
  ),
  admin: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
  ),
};

export interface HmisGlance {
  status: string | null; project: string | null; last_contact: string | null;
  chronic: boolean; veteran: boolean;
  /** for housed clients: HOW — "in <PSH>" (active enrollment, housedOpen)
   *  vs "exited <program> → <destination>" (housed per exit record) */
  housedNote: string | null; housedOpen: boolean;
}

export default function HelplineView({ me, isAdmin, cases, teams, events = {}, callsByCase = {}, callLog = [], hmis = {}, sqlMissing }: {
  me: string; isAdmin: boolean; cases: HlCase[]; teams: Team[];
  /** outreach trail per open case: chronological attempt/contact events */
  events?: Record<number, { at: string; kind: string }[]>;
  /** phone calls received per case (initial + repeat) — the VOLUME record */
  callsByCase?: Record<number, number>;
  /** every phone call's timestamp+kind — demand patterns (day × hour) */
  callLog?: { at: string; kind: string }[];
  /** minimal BNL snapshot per MATCHED pid — the on-row HMIS glance */
  hmis?: Record<string, HmisGlance>;
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
  // Admin-tuned priority policy — effective queue order recomputes LIVE from
  // each case's stored answers + the current rules, so a weight change
  // re-ranks instantly. Reporting keeps the intake-time stored priority.
  const [rules, setRules] = useState<PriorityRules>(DEFAULT_RULES);
  useEffect(() => { fetchPriorityRules().then(setRules); }, []);
  const [qSort, setQSort] = useState<'priority' | 'oldest' | 'newest'>('priority');
  // chronic flags for HMIS-matched open cases — privacy-safe definer fn
  // returns only {case_id, chronic}; empty until helpline_priority.sql runs
  const [chronicIds, setChronicIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabaseBrowser().rpc('helpline_hmis_flags');
        if (!error && Array.isArray(data)) {
          setChronicIds(new Set((data as { case_id: number; chronic: boolean }[])
            .filter((r) => r.chronic).map((r) => Number(r.case_id))));
        }
      } catch { /* pre-SQL — no boost */ }
    })();
  }, [cases]);
  const [tab, setTabState] = useState<HlTab>('queue');
  useEffect(() => {
    const t = localStorage.getItem(HL_TAB_KEY) as HlTab | null;
    if (t && ['queue', 'board', 'cases', 'map', 'admin'].includes(t)) setTabState(t);
  }, []);
  const setTab = (t: HlTab) => {
    setTabState(t);
    try { localStorage.setItem(HL_TAB_KEY, t); } catch { /* private mode */ }
  };
  // a non-admin can't land on the admin tab (e.g. stale localStorage)
  const shownTab: HlTab = tab === 'admin' && !isAdmin ? 'queue' : tab;
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

  // styled team pickers (2026-09-25): options for both menus + board filter
  const teamOpts: TeamOpt[] = useMemo(() => teams.filter((x) => x.active).map((x) => ({
    id: x.id, name: x.name, zones: x.zones ?? [], open: openByTeam.get(x.id) ?? 0,
  })), [teams, openByTeam]);
  const [assignFor, setAssignFor] = useState<number | null>(null);
  const [boardTeams, setBoardTeamsState] = useState<Set<number> | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('hl-board-teams');
      if (raw) { const ids = JSON.parse(raw) as number[]; if (ids.length) setBoardTeamsState(new Set(ids)); }
    } catch { /* private mode */ }
  }, []);
  const setBoardTeams = (v: Set<number> | null) => {
    setBoardTeamsState(v);
    try { if (v) localStorage.setItem('hl-board-teams', JSON.stringify([...v])); else localStorage.removeItem('hl-board-teams'); }
    catch { /* ignore */ }
  };

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
    update(c.id, {
      team_id: teamId, status: 'assigned', assigned_at: new Date().toISOString(),
      // a pin is a queue device — assignment clears it (skip pre-SQL rows)
      ...(c.pinned != null ? { pinned: false } : {}),
    });

  // Admin pin-to-top: the reason is required and lands in the permanent log.
  const togglePin = async (c: HlCase) => {
    if (c.pinned) {
      await db().from('helpline_calls').insert({ case_id: c.id, operator: me,
        kind: 'followup', notes: 'Unpinned from the top of the queue.' });
      return update(c.id, { pinned: false });
    }
    const reason = prompt('Pin to the top of the queue — reason (goes in the case log):');
    if (!reason?.trim()) return;
    await db().from('helpline_calls').insert({ case_id: c.id, operator: me,
      kind: 'followup', notes: `Pinned to top of queue — ${reason.trim()}` });
    return update(c.id, { pinned: true });
  };

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
    if (strikeOut) {
      // the closure itself is a logged event — the drawer must explain WHY
      // the case ended after the third ✗ (user ask 2026-08-20)
      await db().from('helpline_calls').insert({
        case_id: c.id, operator: me, kind: 'followup',
        notes: `Case closed — could not locate. ${MAX_FAILED_ATTEMPTS} failed contact attempts `
          + 'with no successful contact (3-strike rule). Reopen from All cases if they are '
          + 'sighted or call again.',
      });
    }
    return update(c.id, {
      status: strikeOut ? 'no_locate' : c.status === 'assigned' ? 'attempted' : c.status,
      attempts,
      last_attempt: new Date().toISOString().slice(0, 10),
    });
  };

  // Reopen resets the failed-attempt counter — without this, a case closed by
  // the 3-strike rule would re-close on the very next failed try. The dated
  // ✗/✓ events keep the full history; only the strike clock restarts.
  const reopenCase = async (c: HlCase) => {
    await db().from('helpline_calls').insert({
      case_id: c.id, operator: me, kind: 'followup',
      notes: 'Reopened — failed-attempt counter reset (dated tries stay in the log).',
    });
    return update(c.id, { status: c.team_id != null ? 'assigned' : 'new', attempts: 0 });
  };

  // Manual close gets the same treatment: a closure note in the permanent log.
  const closeNoLocate = async (c: HlCase) => {
    await db().from('helpline_calls').insert({
      case_id: c.id, operator: me, kind: 'followup',
      notes: `Case closed — could not locate (closed by outreach; ${c.attempts} failed `
        + `attempt${c.attempts === 1 ? '' : 's'} logged).`,
    });
    return update(c.id, { status: 'no_locate' });
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

  const confirmMatch = async (c: HlCase, pid: string) => {
    const ok = await update(c.id,
      { matched_pid: pid, matched_by: me, matched_at: new Date().toISOString() });
    // Success feedback = the panel CLOSES and the row flips to "linked".
    // Leaving it open read as "nothing happened" (user test 2026-09-11) and
    // invited repeat taps that silently re-wrote the same link.
    if (ok) setOpenId(null);
  };

  // prior-call counts by phone (last 7 digits) — feeds the repeat-call knob
  const priorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cases) {
      const k = (c.phone_callback || c.phone_line || '').replace(/\D/g, '').slice(-7);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [cases]);

  /** Effective queue score = live base (current rules over stored answers)
   *  + waiting-time aging + emergency boost + repeat-call boost. The BAND is
   *  promoted by the total (user-approved); reporting keeps stored priority. */
  const eff = (c: HlCase) => {
    const base = priorityOf(c.factors, c.household, c.sleeping, rules);
    const aging = agingPts(c.created_at, rules);
    const emerg = rules.emergency.active
      && (EMERGENCY_SLEEPING as readonly string[]).includes(c.sleeping ?? '')
      ? rules.emergency.pts : 0;
    const k = (c.phone_callback || c.phone_line || '').replace(/\D/g, '').slice(-7);
    const rep = rules.repeatCall > 0 && k
      ? rules.repeatCall * Math.min(3, Math.max(0, (priorCounts.get(k) ?? 1) - 1)) : 0;
    const chron = chronicIds.has(c.id) ? rules.hmisChronic : 0;
    const pts = base + aging + emerg + rep + chron;
    return { base, aging, extra: emerg + rep + chron, pts, band: priorityBand(pts, rules) };
  };

  const triage = cases.filter((c) => c.status === 'new');
  const working = cases.filter((c) => OPEN_STATUSES.includes(c.status));
  const confirmed = cases.filter((c) => c.status === 'confirmed');
  const done = cases.filter((c) => ['declined', 'no_locate', 'closed', 'referred_out'].includes(c.status));
  const referredOut = cases.filter((c) => c.status === 'referred_out');
  const verified = confirmed.filter((c) => c.verified_entry);
  const unverified = confirmed.filter((c) => !c.verified_entry);

  // Stat-bar window (user ask 2026-09-22): re-count the six stats over cases
  // OPENED in a CALENDAR window — Today (since midnight) / Week (since
  // Monday) / Month (since the 1st) / All (default). Local clock = Miami for
  // operators. Tab badges and the working lists stay unscoped on purpose:
  // the queue is the queue.
  const [statPeriod, setStatPeriod] = useState<'day' | 'week' | 'month' | 'all'>('all');
  const statCases = useMemo(() => {
    if (statPeriod === 'all') return cases;
    const now = new Date();
    const cut = statPeriod === 'day'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      : statPeriod === 'week'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime()
      : new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return cases.filter((c) => new Date(c.created_at).getTime() >= cut);
  }, [cases, statPeriod]);
  const sTriage = statCases.filter((c) => c.status === 'new');
  const sWorking = statCases.filter((c) => OPEN_STATUSES.includes(c.status));
  const sConfirmed = statCases.filter((c) => c.status === 'confirmed');
  const sDone = statCases.filter((c) => ['declined', 'no_locate', 'closed', 'referred_out'].includes(c.status));
  const sReferred = statCases.filter((c) => c.status === 'referred_out');
  const sVerified = sConfirmed.filter((c) => c.verified_entry);
  const sUnverified = sConfirmed.filter((c) => !c.verified_entry);
  const scopeNote = statPeriod === 'all' ? ''
    : ` — cases opened ${statPeriod === 'day' ? 'today (since midnight)'
      : statPeriod === 'week' ? 'this week (since Monday)' : 'this month (since the 1st)'}`;

  const t = q.trim().toLowerCase();
  const searchable = (c: HlCase) =>
    `${nameOf(c)} ${c.phone_line ?? ''} ${c.phone_callback ?? ''} ${c.area ?? ''} ${c.address ?? ''} ${c.notes ?? ''}`.toLowerCase();

  const kpi = (lbl: string, val: number, note: string, kc: string, go?: HlTab) => (
    <button type="button" className="stat" style={{ ['--kc' as any]: kc }}
      title={`${note}${go ? ' — click to open the matching tab' : ''}`}
      onClick={go ? () => setTab(go) : undefined}>
      <span className="dot" />
      <span className="lbl">{lbl}</span>
      <span className="val">{fmtInt(val)}</span>
    </button>
  );

  function CaseCell({ c, e }: { c: HlCase; e?: { base: number; aging: number; extra: number; pts: number; band: string } }) {
    const band = e ? e.band : priorityBand(c.priority, rules);
    return (
      <td style={{ minWidth: 280 }}>
        {c.pinned && <span title="Pinned to the top of the queue by an admin">📌 </span>}
        <span className="bnl-sub" title="Case number — use this when referencing the case"
          style={{ fontVariantNumeric: 'tabular-nums' }}>#{c.id}</span>{' '}
        <button className="bnl-nm" onClick={() => setDrawerC(c)}
          title="Open the case drawer — full details, notes, and history"
          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
            cursor: 'pointer', textDecoration: 'underline',
            textUnderlineOffset: 3, color: 'var(--strong)' }}>{nameOf(c)}</button>{' '}
        <b style={{ color: bandColor(band), fontSize: 11 }}
          title={e ? `${e.base} pts at intake${e.aging ? ` · +${e.aging} for waiting` : ''}${e.extra ? ` · +${e.extra} event/repeat boost` : ''}` : undefined}>
          {band}</b>
        {e && (e.aging > 0 || e.extra > 0) && (
          <span className="bnl-sub" title="Waiting-time and event boosts — transparent math, hover the band">
            {' '}+{e.aging + e.extra}</span>
        )}
        <div className="bnl-sub" style={{ lineHeight: 1.6 }}>
          {c.area ?? 'area unknown'}{c.county_district ? ` · ${c.county_district}` : ''}{c.address ? ` · ${c.address}` : ''}{c.landmark ? ` · ${c.landmark}` : ''}
          {c.sleeping ? ` · ${c.sleeping}` : ''}{c.household && c.household !== 'Alone' ? ` · ${c.household}${c.household_size ? ` (${c.household_size} in household)` : ''}` : ''}
          {c.factors.length > 0 && <> · {c.factors.join(', ')}</>}
          {(c.phone_callback || c.phone_line) && <> · ☎ {c.phone_callback ?? c.phone_line}</>}
          {(callsByCase[c.id] ?? 0) > 1 && (
            <> · <span title={`${callsByCase[c.id]} phone calls received about this case`}
              style={{ fontWeight: 700 }}>☎ ×{callsByCase[c.id]}</span></>
          )}
          {c.referred_to && <> · ↗ {c.referred_to}</>}
          {c.matched_pid && <> · <span className="bnl-fp bnl-fp-sch">HMIS linked</span></>}
        </div>
        {/* On-row HMIS glance for linked cases (user 2026-09-11: "a small
            glance in the triage and team board", not a BNL trip). Housed
            status goes amber — shelter request + housed = referral talk. */}
        {c.matched_pid && hmis[c.matched_pid] && (() => {
          const g = hmis[c.matched_pid!];
          const housed = (g.status ?? '').toLowerCase().includes('housed');
          return (
            <div className={housed ? 'hl-note' : 'bnl-sub'} style={housed ? undefined : { lineHeight: 1.6 }}
              title="HMIS at a glance — from the By-Name List roster for the linked record">
              {/* "possibly housed" on purpose (user 2026-09-11): an HMIS
                  record — even an active enrollment — is a claim, not a
                  verified current fact; the caller on the phone may know
                  better. The glance flags, the operator verifies. */}
              {housed ? '⚠ ' : ''}HMIS: <b style={{ color: housed ? 'var(--warn)' : 'var(--strong)' }}>
                {housed ? 'possibly housed' : (g.status ?? 'known client')}</b>
              {g.chronic && ' · chronic'}
              {g.veteran && ' · veteran'}
              {housed && g.housedNote ? <> · {g.housedNote}</> : g.project ? <> · {g.project}</> : null}
              {g.last_contact && <> · last contact {g.last_contact}</>}
              {housed && (g.housedOpen
                ? <b> — contact their housing provider, not outreach</b>
                : <b> — housed per exit record: verify, then prevention referral if losing it</b>)}
            </div>
          );
        })()}
      </td>
    );
  }

  function MatchPanel({ c }: { c: HlCase }) {
    const list = cands[c.id];
    return (
      <div style={{ padding: '6px 12px 14px' }}>
        {list === 'loading' && <div className="meta">Searching 50k HMIS clients…</div>}
        {Array.isArray(list) && list.length === 0 && (
          <div className="meta">No HMIS candidates — needs a name and DOB/SSN-4 to match well.
            The caller may simply be new to HMIS; confirmation-time auto-link catches them later.</div>
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
        {list !== 'loading' && (
          <button className="tbtn" style={{ marginTop: 2 }}
            title="Close the candidate list without linking — the case stays unmatched and can be searched again anytime"
            onClick={() => setOpenId(null)}>
            ✕ {Array.isArray(list) && list.length ? 'None of these — close' : 'Close'}
          </button>
        )}
      </div>
    );
  }

  // One-row action cluster (user-approved mock 2026-09-22): split button —
  // violet half assigns the suggested team (SHORT name; full name/why/open
  // count in the tooltip), caret half is the real team <select> wearing only
  // its chevron. Supersedes the 2026-08-25 two-row 280px layout.
  // shortTeam: "City of Miami — Team 8 (District 5 + Gov Center)" → "Team 8".
  function AssignControls({ c }: { c: HlCase }) {
    const sug = suggestTeam(c, teams, openByTeam);
    const shortTeam = (name: string) => {
      const base = name.split('(')[0];
      const parts = base.split('—');
      const s = (parts[parts.length - 1] ?? '').trim() || base.trim() || name.trim();
      return s.length > 18 ? `${s.slice(0, 16)}…` : s;
    };
    const menuOpen = assignFor === c.id;
    const pick = (id: number) => { setAssignFor(null); assign(c, id); };
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          {sug ? (
            <span className="split"
              title={`Suggested: ${sug.why} — ${openByTeam.get(sug.team.id) ?? 0} open cases · full name: ${sug.team.name}`}>
              <button type="button" className="smain" disabled={busy} onClick={() => assign(c, sug.team.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Assign <em>{shortTeam(sug.team.name)}</em>
              </button>
              <button type="button" className="scaret" disabled={busy} aria-haspopup="dialog" aria-expanded={menuOpen}
                aria-label="Assign a different team" onClick={() => setAssignFor(menuOpen ? null : c.id)}
                style={{ border: 0, background: 'transparent', cursor: 'pointer', font: 'inherit' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </span>
          ) : (
            <button type="button" className="tsel" disabled={busy} aria-haspopup="dialog" aria-expanded={menuOpen}
              onClick={() => setAssignFor(menuOpen ? null : c.id)} style={{ padding: '5px 12px' }}>
              <span className="tsel-v">Assign team</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          )}
          {menuOpen && (
            <TeamMenu teams={teamOpts} suggestedId={sug?.team.id ?? null} onPick={pick}
              onClose={() => setAssignFor(null)} />
          )}
        </span>
        <button className="tbtn" disabled={busy} style={{ flexShrink: 0 }}
          title="SOP refer-out (prevention · veterans · DV · youth · other-provider areas) — shows the script first"
          onClick={() => setReferFor(c)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
          Refer</button>
        {isAdmin && (
          <button className="tbtn" disabled={busy}
            style={{ flexShrink: 0, ...(c.pinned ? { borderColor: 'var(--warn)', color: 'var(--warn)' } : {}) }}
            aria-label={c.pinned ? 'Unpin from the top of the queue' : 'Pin to the top of the queue'}
            title={c.pinned ? 'Pinned — click to unpin' : 'Pin to the top of the queue — reason goes in the case log'}
            onClick={() => togglePin(c)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill={c.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>
          </button>
        )}
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

      <div className="statbar" style={{ marginBottom: 16 }}>
        {kpi('Awaiting triage', sTriage.length,
          (sTriage.length ? `oldest ${fmtHours(Math.max(...sTriage.map((c) => hoursSince(c.created_at))))} ago` : 'queue is clear') + scopeNote,
          'var(--danger)', 'queue')}
        {rules.slaHours != null && kpi('Past target',
          sTriage.filter((c) => hoursSince(c.created_at) >= (rules.slaHours as number)).length,
          `awaiting triage past the ${rules.slaHours}h response target${scopeNote}`, 'var(--danger)', 'queue')}
        {kpi('With outreach', sWorking.length, 'assigned · attempted · contacted' + scopeNote, 'var(--info)', 'board')}
        {kpi('Confirmed homeless', sConfirmed.length,
          `${fmtInt(sVerified.length)} verified enrolled · ${fmtInt(sUnverified.length)} pending${scopeNote}`, 'var(--accent)', 'cases')}
        {kpi('Enrollment gap', sUnverified.length,
          (sUnverified.length ? 'confirmed but no HMIS enrollment yet' : 'everyone confirmed is enrolled') + scopeNote, 'var(--danger)', 'cases')}
        {kpi('Referred out', sReferred.length,
          'prevention · veterans · DV · youth — right-door diversions' + scopeNote, 'var(--secondary)', 'cases')}
        {kpi('All cases', statCases.length, `${fmtInt(sDone.length)} closed/other${scopeNote}`, 'var(--faint)', 'cases')}
        <span className="statper" role="group" aria-label="Stat window">
          {([['day', 'Today', 'Cases opened today — since midnight'],
             ['week', 'Week', 'Cases opened this week — since Monday'],
             ['month', 'Month', 'Cases opened this month — since the 1st'],
             ['all', 'All', 'Every loaded case']] as const).map(([k, lbl, tip]) => (
            <button key={k} type="button" className={statPeriod === k ? 'on' : undefined}
              title={tip} onClick={() => setStatPeriod(k)}>{lbl}</button>
          ))}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="seg" role="tablist" aria-label="Helpline sections">
          {([
            { k: 'queue' as HlTab, lbl: 'Call queue', n: triage.length, bg: 'var(--danger-light)', fg: 'var(--danger)' },
            { k: 'board' as HlTab, lbl: 'Team board', n: working.length, bg: 'var(--info-light)', fg: 'var(--info)' },
            { k: 'cases' as HlTab, lbl: 'All cases', n: 0, bg: '', fg: '' },
            { k: 'map' as HlTab, lbl: 'Map & reporting', n: 0, bg: '', fg: '' },
            ...(isAdmin ? [{ k: 'admin' as HlTab, lbl: 'Settings', n: 0, bg: '', fg: '' }] : []),
          ]).map(({ k, lbl, n, bg, fg }) => (
            <button key={k} type="button" role="tab" aria-selected={shownTab === k}
              className={shownTab === k ? 'on' : undefined} onClick={() => setTab(k)}>
              {HL_TAB_ICONS[k]}
              {lbl}
              {n > 0 && <span className="segn" style={{ background: bg, color: fg }}>{fmtInt(n)}</span>}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <Link className="btn primary pill" href="/dashboard/helpline/new">{PHONE_ICON} New call</Link>
      </div>

      {shownTab === 'queue' && (
      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Call queue</h3>
            <div className="meta">New calls · priority = intake points + waiting time{rules.emergency.active ? ' + event boost' : ''} · suggestion = factors → area → county district</div>
          </div>
          <div className="fgroup"><span className="flabel">Sort</span>
            <select className="fselect" value={qSort} onChange={(e2) => setQSort(e2.target.value as typeof qSort)}>
              <option value="priority">Priority</option>
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select></div>
        </div>
        {rules.emergency.active && (
          <div className="lerror" role="alert" style={{ margin: '0 18px 10px' }}>
            ⚠ {rules.emergency.label || 'Emergency event'} active — +{rules.emergency.pts} pts
            for callers sleeping outside or in a car (set by an admin in Priority rules).
          </div>
        )}
        {(() => {
          const n = rules.slaHours == null ? 0
            : triage.filter((c) => hoursSince(c.created_at) >= (rules.slaHours as number)).length;
          return n > 0 ? (
            <div className="bnl-sub" style={{ padding: '0 18px 8px', color: 'var(--danger)', fontWeight: 700 }}>
              ⚑ {fmtInt(n)} call{n === 1 ? '' : 's'} past the {rules.slaHours}h response target
            </div>
          ) : null;
        })()}
        {triage.length > 0 && (
          <div className="scroll"><table className="bnl-table hl-rows">
            <thead><tr><th>Called</th><th>Caller</th><th>HMIS</th><th style={{ textAlign: 'right' }}>Assignment</th></tr></thead>
            <tbody>
              {[...triage.map((c) => ({ c, e: eff(c) }))]
                .sort((a, b) => {
                  const pin = Number(b.c.pinned ?? false) - Number(a.c.pinned ?? false);
                  if (pin) return pin;
                  if (qSort === 'oldest') return a.c.created_at.localeCompare(b.c.created_at);
                  if (qSort === 'newest') return b.c.created_at.localeCompare(a.c.created_at);
                  return b.e.pts - a.e.pts || a.c.created_at.localeCompare(b.c.created_at);
                })
                .map(({ c, e }) => {
                const hrs = hoursSince(c.created_at);
                const late = rules.slaHours != null && hrs >= (rules.slaHours as number);
                return (
                <FragmentRow key={c.id} left={<>{when(c.created_at)}
                  <div className="bnl-sub" style={late ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                    {fmtHours(hrs)} ago{late ? ' ⚠' : ''}</div></>}>
                  <CaseCell c={c} e={e} />
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {c.matched_pid
                      ? <Link className="tbtn" href={`/dashboard/bnl?pid=${encodeURIComponent(c.matched_pid)}`}
                          target="_blank" rel="noopener"
                          title="Open this client's HMIS record on the By-Name List in a NEW TAB — the helpline stays put">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          BNL record</Link>
                      : <button className="tbtn" disabled={busy}
                          title="Search the HMIS client index for records matching this caller — you confirm a candidate before anything links"
                          onClick={() => findMatches(c.id)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                          {openId === c.id ? 'Refresh' : 'Find HMIS match'}</button>}
                  </td>
                  <td style={{ textAlign: 'right' }}><AssignControls c={c} /></td>
                  {openId === c.id ? <MatchPanel c={c} /> : null}
                </FragmentRow>
                );
              })}
            </tbody>
          </table></div>
        )}
        {!triage.length && !sqlMissing && (
          <div className="empty" style={{ padding: '10px 18px 16px' }}>Nothing waiting — new calls land here.</div>
        )}
      </div>
      )}

      {shownTab === 'board' && (
      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-h">
          <div>
            <h3>Team board</h3>
            <div className="meta">Open cases by outreach team · log attempts, record the outcome, print the dispatch sheet</div>
          </div>
          <TeamMultiSelect teams={teamOpts} value={boardTeams} onChange={setBoardTeams} />
        </div>
        {/* ONE table for every team (2026-09-25 redesign): a single header and
            fixed column widths so every team's rows line up; teams are band rows. */}
        {working.length > 0 && (
        <div className="scroll"><table className="bnl-table hl-rows hl-board">
          <colgroup><col /><col style={{ width: 140 }} /><col style={{ width: 170 }} /><col style={{ width: 400 }} /></colgroup>
          <thead><tr><th>Case</th><th>Status</th><th>Outreach trail</th>
            <th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>
        {teams.filter((x) => (openByTeam.get(x.id) ?? 0) > 0 && (boardTeams == null || boardTeams.has(x.id))).map((team) => (
          <Fragment key={team.id}>
            <tr className="hl-grp"><td colSpan={4}>
              <span className="hl-grp-nm">{team.name}</span>
              <span className="hl-tag">{fmtInt(openByTeam.get(team.id) ?? 0)} open</span>
              <span className="hl-tag">{team.zones.length ? team.zones.join(', ') : 'no zones set'}</span>
              {(() => {
                const staff = [...(team.member_accounts ?? []).map((a) => a.name),
                  team.members ?? ''].filter(Boolean).join(', ');
                return staff ? <span className="hl-tag" title="Assigned staff">{staff}</span> : null;
              })()}
              {team.dispatch ? <span className="hl-tag" title="Dispatch contact">dispatch: {team.dispatch}</span> : null}
            </td></tr>
                {working.filter((c) => c.team_id === team.id).map((c) => (
                  <FragmentZoneRow key={c.id}>
                  <tr style={{ cursor: 'default' }}>
                    <CaseCell c={c} />
                    <td style={{ whiteSpace: 'nowrap' }}><ChipDated c={c} /></td>
                    <td><Trail events={events[c.id]} c={c} /></td>
                    {/* Two-line action cluster (user mock approval 2026-09-11,
                        "buttons smaller"): quiet utilities on top, color-coded
                        outcomes below (same red ✗ / blue ✓ / green house language
                        as the field app), Close demoted to a text link. Wraps
                        instead of forcing a horizontal scrollbar. */}
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {!c.matched_pid ? (
                            <button className="tbtn" disabled={busy}
                              title="Search HMIS for this caller (DOB / SSN-4 / name) — a person confirms the match"
                              onClick={() => findMatches(c.id)}>
                              {openId === c.id ? 'Refresh' : <><IconSearch size={11} /> HMIS match</>}</button>
                          ) : (
                            <Link className="tbtn"
                              href={`/dashboard/bnl?pid=${encodeURIComponent(c.matched_pid)}`}
                              target="_blank" rel="noopener"
                              title="Open this client's HMIS record on the By-Name List in a NEW TAB — the board stays put">
                              BNL →</Link>
                          )}
                          {(c.lat != null || c.address || c.landmark) && (
                            <button className="tbtn"
                              title="Show where to find them — location details + map, right here"
                              onClick={() => setMapId(mapId === c.id ? null : c.id)}>
                              {mapId === c.id ? 'Hide map' : <><IconMapPin size={11} /> Map</>}</button>
                          )}
                          <Link className="tbtn" href={`/dashboard/helpline/print/${c.id}`} target="_blank"
                            title="One-page dispatch sheet — print or save as PDF for the field team"><IconPrinter size={11} /> Sheet</Link>
                        </div>
                        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <button className="opill no" disabled={busy}
                            title={`Went out, couldn't reach them — bumps the tried counter. ${MAX_FAILED_ATTEMPTS} failed tries with no successful contact auto-closes the case as could-not-locate.`}
                            onClick={() => logAttempt(c)}>
                            ✗ No contact{(c.contacts ?? 0) === 0 && c.attempts === MAX_FAILED_ATTEMPTS - 1 ? ' (final)' : ''}</button>
                          <button className="opill yes" disabled={busy}
                            title="Reached them — bumps the contacted counter; failed tries never erase this"
                            onClick={() => logContact(c)}>✓ Contacted</button>
                          <button className="opill home" disabled={busy}
                            title="Outreach verified this person is homeless — starts the enrollment-verification clock"
                            onClick={() => update(c.id, { status: 'confirmed', confirmed_at: new Date().toISOString().slice(0, 10) })}>
                            <IconHome size={12} /> Confirmed</button>
                        </div>
                        <button className="linkbtn" disabled={busy}
                          title="FINAL — closes the case and removes it from this board. “Couldn't find them today” is Log attempt, not this."
                          onClick={() => {
                            const warn = c.attempts === 0
                              ? 'No attempts have been logged on this case.\n\n'
                              : `${c.attempts} attempt${c.attempts === 1 ? '' : 's'} logged.\n\n`;
                            if (confirm(`${warn}Close this case as COULD NOT LOCATE? It leaves the team board (it can be reopened from All cases).`)) {
                              closeNoLocate(c);
                            }
                          }}>Close as could not locate</button>
                      </div>
                    </td>
                  </tr>
                  {openId === c.id && !c.matched_pid ? (
                    <tr style={{ cursor: 'default' }}>
                      <td colSpan={4} style={{ background: 'var(--rowhover)' }}>
                        <MatchPanel c={c} />
                      </td>
                    </tr>
                  ) : null}
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
                                all we have. Use Locate on intake to add a pin.</div>}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </FragmentZoneRow>
                ))}
          </Fragment>
        ))}
          </tbody>
        </table></div>
        )}
        {!working.length && <div className="empty" style={{ padding: '10px 18px 16px' }}>No assigned cases yet.</div>}
        {working.length > 0 && boardTeams != null && !teams.some((x) => boardTeams.has(x.id) && (openByTeam.get(x.id) ?? 0) > 0) && (
          <div className="empty" style={{ padding: '10px 18px 16px' }}>The selected teams have no open cases.</div>
        )}
      </div>
      )}

      {shownTab === 'cases' && (
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
        <div className="scroll"><table className="bnl-table hl-rows">
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
                  <Link className="tbtn" href={`/dashboard/helpline/print/${c.id}`} target="_blank"><IconPrinter size={11} /> Sheet</Link>
                  {c.matched_pid && (
                    <Link className="tbtn" style={{ marginLeft: 6 }}
                      href={`/dashboard/bnl?pid=${encodeURIComponent(c.matched_pid)}`}>BNL →</Link>
                  )}
                  {['no_locate', 'declined', 'closed', 'referred_out'].includes(c.status) && (
                    <button className="tbtn" style={{ marginLeft: 6 }} disabled={busy}
                      title="Back to the team board (keeps the team) with a fresh attempt counter — e.g. a new sighting or the caller called again"
                      onClick={() => reopenCase(c)}>
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
      )}

      {shownTab === 'map' && (
        <>
          <ReportMap cases={cases} teams={teams} isAdmin={isAdmin} onOpen={(c) => setDrawerC(c)} />
          <Reporting cases={cases} teams={teams} events={events} callsByCase={callsByCase}
            callLog={callLog} rules={rules} hmis={hmis} />
        </>
      )}

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

      {shownTab === 'admin' && isAdmin && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
            <Link href="/field" className="tbtn"
              title="Mobile app for outreach workers — share this link with field staff">
              <IconSmartphone size={12} /> Field app — share with outreach staff</Link>
            <QrShare path="/field" label="QR code" />
          </div>
          <PriorityRulesAdmin me={me} rules={rules}
            onSaved={() => { invalidatePriorityRules(); fetchPriorityRules(true).then(setRules); }} />
          <TeamAdmin teams={teams} busy={busy}
            onCreate={(name) => run(async () => db().from('outreach_teams')
              .insert({ name, zones: [], factors: [] }))}
            onSave={(id, patch) => run(async () => db().from('outreach_teams')
              .update(patch).eq('id', id))} />
        </>
      )}
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

// ── Reporting helpers ─────────────────────────────────────────────────────────
// Day/hour bucketing is MIAMI-local on purpose: timestamps are UTC and the
// question "when do calls come in" is about local staffing hours. Client
// clocks are usually already Eastern, but the explicit zone makes the report
// deterministic anywhere (and matches the server-rendered monthly PDF).
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function miamiDowHour(iso: string): { dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const dow = DOW_LABELS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  return { dow: dow < 0 ? 0 : dow, hour };
}
function fmtHour(h: number): string {
  return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
}
const pctOf = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

/** One bordered card per report section (user 2026-09-10: "everything looks
 *  too together") — a title rule on top, optional full-row span in the grid. */
function ReportCard({ title, span, children }: {
  title: React.ReactNode; span?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10,
      padding: '12px 16px 14px', minWidth: 0,
      ...(span ? { gridColumn: '1 / -1' } : {}) }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '.06em', color: 'var(--strong)',
        borderBottom: '2px solid var(--accent)', paddingBottom: 7, marginBottom: 12 }}>
        {title}</div>
      {children}
    </div>
  );
}

/** Outcome funnel — call → case → assigned → contacted → confirmed → HMIS-verified.
 *  The last stage is the module's promise: outcomes proven by enrollment data
 *  (verify_helpline.py), never self-reported. */
function Funnel({ cases, callsN }: { cases: HlCase[]; callsN: number }) {
  const opened = cases.length;
  const stages = [
    ['Cases opened', opened],
    ['Assigned to outreach', cases.filter((c) => c.assigned_at).length],
    ['Contacted', cases.filter((c) => (c.contacts ?? 0) > 0 || c.confirmed_at
      || c.verified_entry || ['contacted', 'confirmed'].includes(c.status)).length],
    ['Confirmed homeless', cases.filter((c) => c.confirmed_at || c.status === 'confirmed'
      || c.verified_entry).length],
    ['Verified HMIS enrollment', cases.filter((c) => c.verified_entry).length],
  ] as [string, number][];
  const medVerifyDays = median(cases
    .filter((c) => c.verified_entry && c.confirmed_at)
    .map((c) => (new Date(c.verified_entry!).getTime() - new Date(c.confirmed_at!).getTime()) / 86_400_000)
    .filter((d) => d >= 0));
  if (!opened) return null;
  return (
    <ReportCard title="Outcome funnel — from phone call to proven enrollment">
      <div style={{ display: 'grid', gap: 4, maxWidth: 640 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13 }}>
          <span style={{ width: 210, color: 'var(--text)' }}>☎ Calls received</span>
          <b>{fmtInt(callsN)}</b>
          {callsN > opened && <span className="bnl-sub">({fmtInt(callsN - opened)} repeat
            call{callsN - opened === 1 ? '' : 's'} joined an existing case)</span>}
        </div>
        {stages.map(([label, n], i) => (
          <div key={label} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span style={{ width: 210, color: 'var(--text)', flex: 'none' }}>{label}</span>
            <div style={{ flex: 1, height: 16, background: 'var(--track)', borderRadius: 4,
              overflow: 'hidden' }}>
              <div style={{ width: `${opened ? Math.max(2, (n / opened) * 100) : 0}%`, height: '100%',
                background: i === stages.length - 1 ? 'var(--accent)' : 'var(--primary)',
                opacity: i === stages.length - 1 ? 1 : 0.45 + i * 0.12, borderRadius: 4 }} />
            </div>
            <b style={{ width: 40, textAlign: 'right' }}>{fmtInt(n)}</b>
            <span className="bnl-sub" style={{ width: 78 }}>
              {i === 0 ? '100%' : `${pctOf(n, opened)} of cases`}</span>
          </div>
        ))}
      </div>
      {medVerifyDays != null && (
        <div className="bnl-sub" style={{ marginTop: 5 }}>
          Median confirmed → verified HMIS entry: <b style={{ color: 'var(--text)' }}>
            {Math.round(medVerifyDays)}d</b> (enrollment dates read from the HMIS export, not self-reported)
        </div>
      )}
    </ReportCard>
  );
}

/** Demand patterns — when the phone actually rings (Miami-local day × hour). */
function DemandHeat({ calls }: { calls: { at: string; kind: string }[] }) {
  const grid = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const c of calls) { const { dow, hour } = miamiDowHour(c.at); g[dow][hour] += 1; }
    return g;
  }, [calls]);
  if (!calls.length) return null;
  const max = Math.max(1, ...grid.flat());
  const dayTotals = grid.map((r) => r.reduce((a, b) => a + b, 0));
  const hourTotals = Array.from({ length: 24 }, (_, h) => grid.reduce((s, r) => s + r[h], 0));
  const busiestDay = dayTotals.indexOf(Math.max(...dayTotals));
  const busiestHour = hourTotals.indexOf(Math.max(...hourTotals));
  const initial = calls.filter((c) => c.kind === 'initial').length;
  return (
    <ReportCard title="Demand patterns — when calls come in (Miami time)">
      <div style={{ display: 'grid', gridTemplateColumns: '36px repeat(24, minmax(9px, 1fr))',
        gap: 2, maxWidth: 640, alignItems: 'center' }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="bnl-sub" style={{ fontSize: 9.5, textAlign: 'center' }}>
            {h % 6 === 0 ? fmtHour(h) : ''}</span>
        ))}
        {grid.map((row, d) => (
          <Fragment key={d}>
            <span className="bnl-sub" style={{ fontSize: 10.5 }}>{DOW_LABELS[d]}</span>
            {row.map((n, h) => (
              <div key={h} title={`${DOW_LABELS[d]} ${fmtHour(h)} — ${n} call${n === 1 ? '' : 's'}`}
                style={{ height: 15, borderRadius: 2,
                  background: n ? 'var(--accent)' : 'var(--track)',
                  opacity: n ? 0.25 + 0.75 * (n / max) : 0.45 }} />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="bnl-sub" style={{ marginTop: 6 }}>
        Busiest: <b style={{ color: 'var(--text)' }}>{DOW_LABELS[busiestDay]}s</b> and the{' '}
        <b style={{ color: 'var(--text)' }}>{fmtHour(busiestHour)}–{fmtHour((busiestHour + 1) % 24)}</b> hour
        · {fmtInt(initial)} first-time call{initial === 1 ? '' : 's'}, {fmtInt(calls.length - initial)} repeat
      </div>
    </ReportCard>
  );
}

/** Geography — the leadership cut: cases by County Commission District (the
 *  pin-stamped county_district), with the finer area/municipality list beside. */
function Districts({ cases }: { cases: HlCase[] }) {
  if (!cases.length) return null;
  const count = (key: (c: HlCase) => string | null) => {
    const m = new Map<string, number>();
    for (const c of cases) { const k = key(c) || '(no pin)'; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()];
  };
  const dist = count((c) => c.county_district).sort((a, b) =>
    (parseInt(a[0].replace(/\D/g, ''), 10) || 99) - (parseInt(b[0].replace(/\D/g, ''), 10) || 99));
  const areas = count((c) => c.area).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...dist.map(([, n]) => n));
  const bar = (n: number) => (
    <div style={{ width: 90, height: 9, background: 'var(--track)', borderRadius: 3,
      display: 'inline-block', verticalAlign: 'middle' }}>
      <div style={{ width: `${(n / max) * 100}%`, height: '100%', background: 'var(--accent)',
        borderRadius: 3 }} />
    </div>
  );
  const table = (title: string, rows: [string, number][], withBar: boolean) => (
    <ReportCard title={title}>
      <table className="bnl-table" style={{ maxWidth: 360 }}>
        <thead><tr><th>{withBar ? 'District' : 'Area'}</th>
          <th className="num">Cases</th><th className="num">{withBar ? '' : 'Share'}</th></tr></thead>
        <tbody>
          {rows.map(([k, n]) => (
            <tr key={k} style={{ cursor: 'default' }}>
              <td style={k === '(no pin)' ? { color: 'var(--faint)' } : undefined}>{k}</td>
              <td className="num">{fmtInt(n)}</td>
              <td className="num">{withBar ? bar(n) : <span className="bnl-sub">{pctOf(n, cases.length)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReportCard>
  );
  return (
    <>
      {table('Cases by County Commission District', dist, true)}
      {areas.length > 0 && table('Top areas / municipalities', areas, false)}
    </>
  );
}

/** Breakdown explorer — one cross-tab answers the granular questions:
 *  "which district refers most to what resource", "20 calls from District 5,
 *  10% seniors". Rows = a case dimension, split = a second one; cells show
 *  n and % of that row's calls. Factors are tap-all-that-apply, so a case
 *  can appear in several factor columns. */
type BdRow = 'district' | 'area' | 'team' | 'household' | 'sleeping' | 'band' | 'status' | 'referred';
type BdCol = 'none' | 'referred' | 'factor' | 'household' | 'sleeping' | 'band' | 'status';
const BD_ROWS: [BdRow, string][] = [
  ['district', 'County district'], ['area', 'Area / municipality'], ['team', 'Team'],
  ['household', 'Household'], ['sleeping', 'Sleeping situation'], ['band', 'Priority band'],
  ['status', 'Status'], ['referred', 'Referred to'],
];
const BD_COLS: [BdCol, string][] = [
  ['referred', 'Referred to'], ['factor', 'Factor'], ['household', 'Household'],
  ['sleeping', 'Sleeping situation'], ['band', 'Priority band'], ['status', 'Status'],
  ['none', '— counts only —'],
];
function Breakdown({ cases, teams, rules }: { cases: HlCase[]; teams: Team[]; rules: PriorityRules }) {
  const [row, setRow] = useState<BdRow>('district');
  const [col, setCol] = useState<BdCol>('referred');
  if (!cases.length) return null;
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const rowOf = (c: HlCase): string => {
    switch (row) {
      case 'district': return c.county_district || '(no pin)';
      case 'area': return c.area || c.county_district || '(none)';
      case 'team': return c.team_id != null ? (teamName.get(c.team_id) ?? `Team ${c.team_id}`) : '(unassigned)';
      case 'household': return c.household || '(not asked)';
      case 'sleeping': return c.sleeping || '(not asked)';
      case 'band': return priorityBand(c.priority ?? 0, rules);
      case 'status': return STATUS_CHIP[c.status]?.[0] ?? c.status;
      case 'referred': return c.referred_to || (c.status === 'referred_out' ? '(unspecified)' : '(not referred)');
    }
  };
  const colsOf = (c: HlCase): string[] => {
    switch (col) {
      case 'none': return [];
      case 'referred': return c.referred_to ? [c.referred_to]
        : c.status === 'referred_out' ? ['(unspecified)'] : [];
      case 'factor': return c.factors ?? [];
      case 'household': return c.household ? [c.household] : [];
      case 'sleeping': return c.sleeping ? [c.sleeping] : [];
      case 'band': return [priorityBand(c.priority ?? 0, rules)];
      case 'status': return [STATUS_CHIP[c.status]?.[0] ?? c.status];
    }
  };
  const rowTotals = new Map<string, number>();
  const cells = new Map<string, Map<string, number>>();
  const colTotals = new Map<string, number>();
  for (const c of cases) {
    const r = rowOf(c);
    rowTotals.set(r, (rowTotals.get(r) ?? 0) + 1);
    for (const k of colsOf(c)) {
      colTotals.set(k, (colTotals.get(k) ?? 0) + 1);
      const m = cells.get(r) ?? new Map<string, number>();
      m.set(k, (m.get(k) ?? 0) + 1);
      cells.set(r, m);
    }
  }
  const rowList = [...rowTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const colList = [...colTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const shortCol = (k: string) => (k.length > 26 ? `${k.slice(0, 24)}…` : k);
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = [BD_ROWS.find(([k]) => k === row)![1], 'cases', 'pct_of_all', ...colList];
    const body = rowList.map(([r, n]) => [r, n, `${Math.round((n / cases.length) * 100)}%`,
      ...colList.map((k) => cells.get(r)?.get(k) ?? 0)].map(esc).join(','));
    const blob = new Blob(['﻿' + [head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `helpline_breakdown_${row}_by_${col}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <ReportCard span title={
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', textTransform: 'none' }}>
        <span style={{ textTransform: 'uppercase' }}>🔍 Breakdown —</span>
        <select className="fselect" value={row} style={{ minWidth: 0, padding: '4px 24px 4px 9px', fontSize: 12 }}
          onChange={(e) => setRow(e.target.value as BdRow)}>
          {BD_ROWS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span style={{ textTransform: 'uppercase' }}>split by</span>
        <select className="fselect" value={col} style={{ minWidth: 0, padding: '4px 24px 4px 9px', fontSize: 12 }}
          onChange={(e) => setCol(e.target.value as BdCol)}>
          {BD_COLS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="tbtn" style={{ marginLeft: 4 }} onClick={exportCsv}><IconDownload size={11} /> CSV</button>
      </span>
    }>
      <div className="scroll"><table className="bnl-table">
        <thead><tr>
          <th>{BD_ROWS.find(([k]) => k === row)![1]}</th>
          <th className="num">Cases</th><th className="num">% of all</th>
          {colList.map((k) => <th key={k} className="num" title={k}>{shortCol(k)}</th>)}
        </tr></thead>
        <tbody>
          {rowList.map(([r, n]) => (
            <tr key={r} style={{ cursor: 'default' }}>
              <td style={r.startsWith('(') ? { color: 'var(--faint)' } : undefined}>{r}</td>
              <td className="num"><b>{fmtInt(n)}</b></td>
              <td className="num"><span className="bnl-sub">{pctOf(n, cases.length)}</span></td>
              {colList.map((k) => {
                const v = cells.get(r)?.get(k) ?? 0;
                return (
                  <td key={k} className="num">
                    {v ? <>{fmtInt(v)} <span className="bnl-sub">· {pctOf(v, n)}</span></>
                      : <span className="bnl-sub">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="bnl-sub" style={{ marginTop: 6 }}>
        Cell % = share of that row&rsquo;s calls — &ldquo;20 calls from County District 5 · 2 (10%) with the
        60+ factor&rdquo;.{col === 'factor' && ' Factors are tap-all-that-apply, so one call can land in several columns.'}
        {' '}Follows the window above; top 14 rows and 8 columns shown, full pivot in the CSV.
      </div>
    </ReportCard>
  );
}

/** Call volume by ZIP CODE — a choropleth of the county's official zip
 *  boundaries (public/gis/zipcodes.geojson, Miami-Dade GIS). Zips are
 *  resolved from each case's geocoded pin at report time (point-in-polygon),
 *  so no schema change and history lights up too; volume weights each case
 *  by its call count. */
function ZipHeat({ cases, callsByCase }: {
  cases: HlCase[]; callsByCase: Record<number, number>;
}) {
  const [geo, setGeo] = useState<GeoFC | null>(null);
  useEffect(() => {
    fetch('/gis/zipcodes.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setGeo(j))
      .catch(() => setGeo(null));
  }, []);

  const { counts, unpinned } = useMemo(() => {
    const m = new Map<string, number>();
    let missed = 0;
    if (geo) {
      for (const c of cases) {
        if (c.lat == null || c.lng == null) { missed += 1; continue; }
        const hit = geo.features.find((f) => inFeature(c.lng!, c.lat!, f.geometry));
        const zip = hit?.properties?.ZIPCODE != null ? String(hit.properties.ZIPCODE) : null;
        if (zip) m.set(zip, (m.get(zip) ?? 0) + Math.max(1, callsByCase[c.id] ?? 1));
        else missed += 1;
      }
    }
    return { counts: m, unpinned: missed };
  }, [geo, cases, callsByCase]);

  // Web-Mercator projection of every ring into one viewBox — the same math
  // as the tile maps, so shapes look right, not squashed.
  const shapes = useMemo(() => {
    if (!geo) return null;
    const Z = 10;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const rings: { zip: string; rings: { x: number; y: number }[][] }[] = [];
    for (const f of geo.features) {
      const zip = f.properties?.ZIPCODE != null ? String(f.properties.ZIPCODE) : '';
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      const rs: { x: number; y: number }[][] = [];
      for (const p of polys) for (const ring of p as number[][][]) {
        rs.push(ring.map(([lng, lat]) => {
          const { px, py } = project(lat, lng, Z);
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          return { x: px, y: py };
        }));
      }
      rings.push({ zip, rings: rs });
    }
    return { rings, x0, y0, w: x1 - x0, h: y1 - y0 };
  }, [geo]);

  if (!geo || !shapes || !cases.length) return null;
  const max = Math.max(1, ...counts.values());
  const W = 400, H = Math.round((shapes.h / shapes.w) * W);
  const sc = W / shapes.w;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const totalCalls = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <ReportCard title="Call volume by zip code" span>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: 'min(400px, 100%)', height: 'auto' }}
          role="img" aria-label="Call volume by zip code choropleth">
          {shapes.rings.map(({ zip, rings }, i) => {
            const n = counts.get(zip) ?? 0;
            const d = rings.map((r) => r.map((pt, j) =>
              `${j ? 'L' : 'M'}${((pt.x - shapes.x0) * sc).toFixed(1)} ${((pt.y - shapes.y0) * sc).toFixed(1)}`)
              .join('') + 'Z').join('');
            return (
              <path key={`${zip}-${i}`} d={d} fillRule="evenodd"
                fill={n ? 'var(--accent)' : 'var(--track)'}
                fillOpacity={n ? 0.3 + 0.7 * (n / max) : 0.45}
                stroke="var(--border)" strokeWidth={0.6}>
                <title>{zip || '(unlabeled)'} — {n} call{n === 1 ? '' : 's'}</title>
              </path>
            );
          })}
        </svg>
        <div style={{ minWidth: 190 }}>
          <table className="bnl-table" style={{ maxWidth: 260 }}>
            <thead><tr><th>Zip</th><th className="num">Calls</th><th className="num">Share</th></tr></thead>
            <tbody>
              {top.length ? top.map(([zip, n]) => (
                <tr key={zip} style={{ cursor: 'default' }}>
                  <td>{zip}</td><td className="num">{fmtInt(n)}</td>
                  <td className="num"><span className="bnl-sub">{pctOf(n, totalCalls)}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="bnl-sub">No mapped calls yet — zips light up as
                  pinned calls come in.</td></tr>
              )}
            </tbody>
          </table>
          {unpinned > 0 && (
            <div className="bnl-sub" style={{ marginTop: 6 }}>
              {fmtInt(unpinned)} case{unpinned === 1 ? '' : 's'} without a map pin — use Locate
              on intake so every call lands on the map.
            </div>
          )}
        </div>
      </div>
    </ReportCard>
  );
}

/** What need is calling in — factor frequencies, priority bands, emergency sleeping. */
function FactorMix({ cases, rules }: { cases: HlCase[]; rules: PriorityRules }) {
  if (!cases.length) return null;
  const counts = FACTORS
    .map((f) => [f.key, cases.filter((c) => (c.factors ?? []).includes(f.key)).length] as [string, number])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const bands = { HIGH: 0, MED: 0, LOW: 0 };
  for (const c of cases) bands[priorityBand(c.priority ?? 0, rules)] += 1;
  const emergency = cases.filter((c) =>
    (EMERGENCY_SLEEPING as readonly string[]).includes(c.sleeping ?? '')).length;
  return (
    <ReportCard title="Who is calling — factors &amp; priority mix">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        {(['HIGH', 'MED', 'LOW'] as const).map((b) => (
          <span key={b} className="bnl-chip" style={{ background: 'var(--track)', color: bandColor(b) }}>
            {b} {fmtInt(bands[b])} · {pctOf(bands[b], cases.length)}</span>
        ))}
        <span className="bnl-chip" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}
          title={`Sleeping: ${(EMERGENCY_SLEEPING as readonly string[]).join(' or ')}`}>
          ⚠ unsheltered/car {fmtInt(emergency)} · {pctOf(emergency, cases.length)}</span>
      </div>
      {counts.length > 0 && (
        <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
          {counts.map(([k, n]) => (
            <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
              <span style={{ width: 210, color: 'var(--text)', flex: 'none' }}>{k}</span>
              <div style={{ flex: 1, height: 11, background: 'var(--track)', borderRadius: 3 }}>
                <div style={{ width: `${(n / cases.length) * 100}%`, height: '100%',
                  background: 'var(--accent)', borderRadius: 3, minWidth: 2 }} />
              </div>
              <b style={{ width: 40, textAlign: 'right' }}>{fmtInt(n)}</b>
              <span className="bnl-sub" style={{ width: 78 }}>{pctOf(n, cases.length)} of cases</span>
            </div>
          ))}
        </div>
      )}
    </ReportCard>
  );
}

/** Shared row shape for the report cards — label 13px text, bar, bold count,
 *  sub share. Matches the bnl-table baseline (normalization 2026-09-22). */
function StatRow({ label, n, of, color = 'var(--accent)', sub, indent }: {
  label: string; n: number; of: number; color?: string; sub?: string; indent?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
      <span style={{ width: 210, color: indent ? 'var(--muted)' : 'var(--text)', flex: 'none',
        paddingLeft: indent ? 16 : 0 }}>{label}</span>
      <div style={{ flex: 1, height: 11, background: 'var(--track)', borderRadius: 3 }}>
        <div style={{ width: `${of ? (n / of) * 100 : 0}%`, height: '100%',
          background: color, borderRadius: 3, minWidth: n ? 2 : 0 }} />
      </div>
      <b style={{ width: 40, textAlign: 'right' }}>{fmtInt(n)}</b>
      <span className="bnl-sub" style={{ width: 78 }}>{sub ?? `${pctOf(n, of)} of cases`}</span>
    </div>
  );
}

/** Volume trend — cases opened per week (Mondays, local), verified overlay.
 *  Answers "is volume rising and are outcomes keeping pace" over the window. */
function WeeklyTrend({ cases }: { cases: HlCase[] }) {
  const weeks = useMemo(() => {
    const by = new Map<number, { opened: number; verified: number }>();
    for (const c of cases) {
      const d = new Date(c.created_at);
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      const k = monday.getTime();
      const e = by.get(k) ?? { opened: 0, verified: 0 };
      e.opened += 1;
      if (c.verified_entry) e.verified += 1;
      by.set(k, e);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).slice(-12);
  }, [cases]);
  if (weeks.length < 2) return null;
  const max = Math.max(1, ...weeks.map(([, w]) => w.opened));
  return (
    <ReportCard title="Volume trend — cases opened per week">
      <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        {weeks.map(([k, w]) => (
          <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span style={{ width: 210, color: 'var(--text)', flex: 'none' }}>
              week of {new Date(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            <div style={{ flex: 1, height: 11, background: 'var(--track)', borderRadius: 3,
              position: 'relative' }}>
              <div style={{ width: `${(w.opened / max) * 100}%`, height: '100%',
                background: 'var(--primary)', opacity: 0.55, borderRadius: 3, minWidth: 2 }} />
              <div style={{ width: `${(w.verified / max) * 100}%`, height: '100%',
                background: 'var(--accent)', borderRadius: 3, position: 'absolute', top: 0, left: 0 }} />
            </div>
            <b style={{ width: 40, textAlign: 'right' }}>{fmtInt(w.opened)}</b>
            <span className="bnl-sub" style={{ width: 78 }}>
              {w.verified ? `${fmtInt(w.verified)} verified` : '—'}</span>
          </div>
        ))}
      </div>
      <div className="bnl-sub" style={{ marginTop: 5 }}>
        Violet = cases opened · green = later verified as HMIS-enrolled (same scale)
      </div>
    </ReportCard>
  );
}

/** Known-to-HMIS mix — are callers new to the system, or people we already
 *  know? Matches are operator-confirmed; flags read from the BNL roster. */
function HmisMix({ cases, hmis }: {
  cases: HlCase[]; hmis: Record<string, { chronic: boolean; veteran: boolean }>;
}) {
  if (!cases.length) return null;
  const matched = cases.filter((c) => c.matched_pid);
  const chronic = matched.filter((c) => hmis[c.matched_pid!]?.chronic);
  const veteran = matched.filter((c) => hmis[c.matched_pid!]?.veteran);
  return (
    <ReportCard title="Known to HMIS — new faces vs returning">
      <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        <StatRow label="Matched to an HMIS record" n={matched.length} of={cases.length} color="var(--info)" />
        {chronic.length > 0 && <StatRow indent label="chronic on the BNL" n={chronic.length} of={cases.length} color="var(--danger)" />}
        {veteran.length > 0 && <StatRow indent label="veteran" n={veteran.length} of={cases.length} color="var(--secondary)" />}
        <StatRow label="No HMIS match yet" n={cases.length - matched.length} of={cases.length} color="var(--faint)" />
      </div>
      <div className="bnl-sub" style={{ marginTop: 5 }}>
        Matches are confirmed person-by-person via Find HMIS match — unmatched includes callers
        not yet searched, so read this as a floor, not a census.
      </div>
    </ReportCard>
  );
}

/** Coverage gaps — calls whose area AND county district no active team
 *  covers. The direct to-do list for Settings → Team coverage. */
function CoverageGaps({ cases, teams }: { cases: HlCase[]; teams: Team[] }) {
  if (!cases.length) return null;
  const covered = (z: string) => teams.some((t) => t.active && t.zones.includes(z));
  const by = new Map<string, number>();
  let noPin = 0;
  for (const c of cases) {
    const zs = [c.area, c.county_district].filter(Boolean) as string[];
    if (!zs.length) { noPin += 1; continue; }
    if (!zs.some(covered)) {
      const k = c.area || c.county_district!;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
  }
  const gaps = [...by.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <ReportCard title="Coverage gaps — calls no team's zones reach">
      {gaps.length ? (
        <>
          <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
            {gaps.slice(0, 8).map(([z, n]) => (
              <StatRow key={z} label={z} n={n} of={cases.length} color="var(--warn)" />
            ))}
          </div>
          <div className="bnl-sub" style={{ marginTop: 5 }}>
            These calls needed manual routing — add the zone to a team under Settings → Team coverage.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>
          ✓ Every pinned call falls inside a covered zone.
        </div>
      )}
      {noPin > 0 && (
        <div className="bnl-sub" style={{ marginTop: 5 }}>
          {fmtInt(noPin)} case{noPin === 1 ? '' : 's'} had no pin or area at all — unroutable
          until a location lands.
        </div>
      )}
    </ReportCard>
  );
}

/** Repeat-caller pressure — rising repeats = people not resolved first pass. */
function RepeatPressure({ cases, callsByCase }: {
  cases: HlCase[]; callsByCase: Record<number, number>;
}) {
  if (!cases.length) return null;
  const nOf = (c: HlCase) => Math.max(1, callsByCase[c.id] ?? 1);
  const one = cases.filter((c) => nOf(c) === 1).length;
  const two = cases.filter((c) => nOf(c) === 2).length;
  const more = cases.filter((c) => nOf(c) >= 3);
  const top = [...cases].filter((c) => nOf(c) >= 2)
    .sort((a, b) => nOf(b) - nOf(a)).slice(0, 3);
  return (
    <ReportCard title="Repeat callers — who keeps calling back">
      <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        <StatRow label="Resolved in one call" n={one} of={cases.length} />
        <StatRow label="Called twice" n={two} of={cases.length} color="var(--warn)" />
        <StatRow label="Called 3+ times" n={more.length} of={cases.length} color="var(--danger)" />
      </div>
      {top.length > 0 && (
        <div className="bnl-sub" style={{ marginTop: 5 }}>
          Most calls: {top.map((c) => `#${c.id} ${[c.first_name, c.last_name].filter(Boolean).join(' ')
            || 'anonymous'} (${nOf(c)})`).join(' · ')} — repeat calls join the open case, so high
          counts mean unresolved need, not duplicates.
        </div>
      )}
    </ReportCard>
  );
}

/** Families — the "With children" cut, powered by the household-size intake
 *  follow-up (helpline_household.sql). */
function FamilyStats({ cases }: { cases: HlCase[] }) {
  const fam = cases.filter((c) => c.household === 'With children');
  if (!fam.length) return null;
  const sized = fam.filter((c) => (c.household_size ?? 0) > 0);
  const avg = sized.length
    ? sized.reduce((s, c) => s + (c.household_size ?? 0), 0) / sized.length : null;
  const single = cases.filter((c) => c.household === 'Alone');
  const rate = (l: HlCase[]) => (l.length ? pctOf(l.filter((c) => c.verified_entry).length, l.length) : '—');
  return (
    <ReportCard title="Families on the line — callers with children">
      <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        <StatRow label="With children" n={fam.length} of={cases.length} color="var(--secondary)" />
        {single.length > 0 && <StatRow label="Alone" n={single.length} of={cases.length} color="var(--faint)" />}
      </div>
      <div className="bnl-sub" style={{ marginTop: 5 }}>
        {avg != null && <>Average household size <b style={{ color: 'var(--text)' }}>{avg.toFixed(1)}</b> (
          {fmtInt(sized.length)} of {fmtInt(fam.length)} families answered the size question) · </>}
        verified HMIS enrollment: families <b style={{ color: 'var(--text)' }}>{rate(fam)}</b> vs
        single adults <b style={{ color: 'var(--text)' }}>{rate(single)}</b>
      </div>
    </ReportCard>
  );
}

/** SLA attainment — % of calls assigned within the response target + weekly
 *  trend. The target itself is admin-set (Settings → Priority rules). */
function SlaCard({ cases, rules }: { cases: HlCase[]; rules: PriorityRules }) {
  if (rules.slaHours == null) {
    return (
      <ReportCard title="Response target — assignment SLA">
        <div className="bnl-sub">No response target set — an admin can set SLA hours under
          Settings → Priority rules, and this card will score every call against it.</div>
      </ReportCard>
    );
  }
  const sla = rules.slaHours as number;
  const hrs = (c: HlCase) =>
    (new Date(c.assigned_at!).getTime() - new Date(c.created_at).getTime()) / 3_600_000;
  const assigned = cases.filter((c) => c.assigned_at && hrs(c) >= 0);
  const within = assigned.filter((c) => hrs(c) <= sla);
  const breaching = cases.filter((c) => c.status === 'new' && hoursSince(c.created_at) >= sla);
  if (!assigned.length && !breaching.length) return null;
  const by = new Map<number, { n: number; ok: number }>();
  for (const c of assigned) {
    const d = new Date(c.created_at);
    const k = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    const e = by.get(k) ?? { n: 0, ok: 0 };
    e.n += 1;
    if (hrs(c) <= sla) e.ok += 1;
    by.set(k, e);
  }
  const weeks = [...by.entries()].sort((a, b) => a[0] - b[0]).slice(-8);
  const rate = assigned.length ? within.length / assigned.length : 0;
  return (
    <ReportCard title={`Response target — assigned within ${sla}h`}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 24, fontWeight: 800,
          color: rate >= 0.8 ? 'var(--accent)' : rate >= 0.5 ? 'var(--warn)' : 'var(--danger)' }}>
          {pctOf(within.length, assigned.length)}</span>
        <span className="bnl-sub">{fmtInt(within.length)} of {fmtInt(assigned.length)} assigned within target</span>
        {breaching.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 700 }}>
            ⚑ {fmtInt(breaching.length)} in the queue past it right now</span>
        )}
      </div>
      {weeks.length >= 2 && (
        <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
          {weeks.map(([k, w]) => (
            <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
              <span style={{ width: 210, color: 'var(--text)', flex: 'none' }}>
                week of {new Date(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              <div style={{ flex: 1, height: 11, background: 'var(--track)', borderRadius: 3 }}>
                <div style={{ width: `${(w.ok / w.n) * 100}%`, height: '100%',
                  background: 'var(--accent)', borderRadius: 3, minWidth: w.ok ? 2 : 0 }} />
              </div>
              <b style={{ width: 52, textAlign: 'right' }}>{pctOf(w.ok, w.n)}</b>
              <span className="bnl-sub" style={{ width: 66 }}>n={fmtInt(w.n)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="bnl-sub" style={{ marginTop: 5 }}>
        Counted call received → team assignment; calls never assigned aren&rsquo;t scored until they are.
      </div>
    </ReportCard>
  );
}

/** Priority QA — is the scoring real? HIGH-band calls should reach a team
 *  faster than LOW; if not, the queue is being worked out of order. */
function BandQa({ cases, rules }: { cases: HlCase[]; rules: PriorityRules }) {
  if (!cases.length) return null;
  const fmtH = (h: number | null) =>
    (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`);
  const rows = (['HIGH', 'MED', 'LOW'] as const).map((b) => {
    const list = cases.filter((c) => priorityBand(c.priority ?? 0, rules) === b);
    const asg = list.filter((c) => c.assigned_at)
      .map((c) => (new Date(c.assigned_at!).getTime() - new Date(c.created_at).getTime()) / 3_600_000)
      .filter((h) => h >= 0);
    const contacted = list.filter((c) => (c.contacts ?? 0) > 0 || c.confirmed_at
      || c.verified_entry || ['contacted', 'confirmed'].includes(c.status)).length;
    return { b, n: list.length, med: median(asg), contacted };
  }).filter((r) => r.n > 0);
  if (rows.length < 2) return null;
  const hi = rows[0];
  const lo = rows[rows.length - 1];
  const verdict = hi.b === 'HIGH' && hi.med != null && lo.med != null
    ? (hi.med <= lo.med
      ? `HIGH calls reach a team ${fmtH(lo.med - hi.med)} faster than ${lo.b} — the scoring is doing its job.`
      : `⚠ HIGH calls are NOT moving faster than ${lo.b} — the queue is being worked out of priority order.`)
    : null;
  return (
    <ReportCard title="Priority check — do HIGH calls move faster?">
      <table className="bnl-table" style={{ maxWidth: 560 }}>
        <thead><tr><th>Band</th><th className="num">Cases</th>
          <th className="num">Median call → assigned</th><th className="num">Contacted</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.b} style={{ cursor: 'default' }}>
              <td><b style={{ color: bandColor(r.b) }}>{r.b}</b></td>
              <td className="num">{fmtInt(r.n)}</td>
              <td className="num">{fmtH(r.med)}</td>
              <td className="num">{pctOf(r.contacted, r.n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {verdict && <div className="bnl-sub" style={{ marginTop: 6 }}>{verdict}</div>}
    </ReportCard>
  );
}

/** Refer-out bounce — diverted callers who came back as a NEW case (same
 *  phone, last-7-digit match — the attachToCase convention). High bounce =
 *  that referral door isn't actually holding. */
function ReferBounce({ cases, pool }: { cases: HlCase[]; pool: HlCase[] }) {
  const ro = cases.filter((c) => c.status === 'referred_out');
  if (!ro.length) return null;
  const ph = (c: HlCase) => {
    const p = (c.phone_callback || c.phone_line || '').replace(/\D/g, '');
    return p.length >= 7 ? p.slice(-7) : null;
  };
  const trackable = ro.filter((c) => ph(c));
  const bounced = (c: HlCase, days: number) => {
    const p = ph(c);
    if (!p) return false;
    const t0 = new Date(c.created_at).getTime();
    return pool.some((o) => o.id !== c.id && ph(o) === p
      && new Date(o.created_at).getTime() > t0
      && new Date(o.created_at).getTime() <= t0 + days * 86_400_000);
  };
  const b30 = trackable.filter((c) => bounced(c, 30));
  const b60 = trackable.filter((c) => bounced(c, 60));
  return (
    <ReportCard title="↩ Referral bounce — diverted callers who came back">
      <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        <StatRow label="Referred out, trackable by phone" n={trackable.length} of={ro.length}
          color="var(--secondary)" sub={`of ${fmtInt(ro.length)} referred`} />
        <StatRow label="Back as a new case ≤ 30d" n={b30.length} of={trackable.length}
          color="var(--warn)" sub={pctOf(b30.length, trackable.length)} />
        <StatRow label="Back as a new case ≤ 60d" n={b60.length} of={trackable.length}
          color="var(--danger)" sub={pctOf(b60.length, trackable.length)} />
      </div>
      <div className="bnl-sub" style={{ marginTop: 5 }}>
        Same phone reappearing as a NEW case after the referral — repeat calls that
        joined the original case don&rsquo;t count. {ro.length - trackable.length > 0 &&
          `${fmtInt(ro.length - trackable.length)} referral${ro.length - trackable.length === 1 ? '' : 's'}
          had no phone and can't be tracked.`}
      </div>
    </ReportCard>
  );
}

/** Tries-to-reach funnel — attempts before the FIRST contact, from the
 *  per-try event log; calibrates the 3-strike rule. */
function TriesFunnel({ cases, events }: {
  cases: HlCase[]; events: Record<number, { at: string; kind: string }[]>;
}) {
  const tracked = cases.filter((c) => (events[c.id] ?? []).length > 0);
  if (!tracked.length) return null;
  let first = 0, second = 0, third = 0;
  const unreached: HlCase[] = [];
  for (const c of tracked) {
    const i = events[c.id].findIndex((e) => e.kind === 'contact');
    if (i < 0) { unreached.push(c); continue; }
    if (i === 0) first += 1;
    else if (i === 1) second += 1;
    else third += 1;
  }
  const noLocate = unreached.filter((c) => c.status === 'no_locate').length;
  const stillTrying = unreached.filter((c) => OPEN_STATUSES.includes(c.status)).length;
  return (
    <ReportCard title="Tries to reach someone — the 3-strike picture">
      <div style={{ display: 'grid', gap: 3, maxWidth: 640 }}>
        <StatRow label="Reached on the 1st try" n={first} of={tracked.length} />
        <StatRow label="Reached on the 2nd try" n={second} of={tracked.length} color="var(--info)" />
        <StatRow label="Reached on the 3rd+ try" n={third} of={tracked.length} color="var(--warn)" />
        <StatRow label="Never reached — closed no-locate" n={noLocate} of={tracked.length} color="var(--danger)" />
        <StatRow label="Never reached — still trying" n={stillTrying} of={tracked.length} color="var(--faint)" />
      </div>
      <div className="bnl-sub" style={{ marginTop: 5 }}>
        Only cases with per-try tracking (2026-08-19 onward). Three failed tries
        close a case as could-not-locate — the last two rows are that rule in motion.
      </div>
    </ReportCard>
  );
}

/**
 * Per-team performance table (user ask 2026-08-19): assigned / open /
 * confirmed / verified-enrolled / no-locate / declined, plus median hours
 * from call to assignment. Computed from the loaded cases (newest 500) —
 * when volume outgrows that, this moves server-side; the columns won't change.
 */
function Reporting({ cases: allCases, teams, events, callsByCase = {}, callLog = [], rules, hmis = {} }: {
  cases: HlCase[]; teams: Team[]; events: Record<number, { at: string; kind: string }[]>;
  callsByCase?: Record<number, number>;
  callLog?: { at: string; kind: string }[];
  rules: PriorityRules;
  hmis?: Record<string, { chronic: boolean; veteran: boolean }>;
}) {
  // One period filter feeds EVERY section below (cases by created_at, calls
  // by received_at) so the funnel, heat grid, districts, factors, team table
  // and refer-outs always describe the same window. Calendar presets + a
  // custom from→to range (user ask 2026-09-22).
  const [period, setPeriod] = useState<'day' | 'week' | 'month' | 'all' | 'custom'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const win = useMemo(() => {
    const now = new Date();
    if (period === 'day') {
      return { lo: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), hi: Infinity };
    }
    if (period === 'week') {
      return { lo: new Date(now.getFullYear(), now.getMonth(),
        now.getDate() - ((now.getDay() + 6) % 7)).getTime(), hi: Infinity };
    }
    if (period === 'month') {
      return { lo: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), hi: Infinity };
    }
    if (period === 'custom') {
      return {
        lo: from ? new Date(`${from}T00:00:00`).getTime() : 0,
        hi: to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity,
      };
    }
    return { lo: 0, hi: Infinity };
  }, [period, from, to]);
  const cases = useMemo(() => allCases.filter((c) => {
    const t = new Date(c.created_at).getTime();
    return t >= win.lo && t <= win.hi;
  }), [allCases, win]);
  const calls = useMemo(() => callLog.filter((e) => {
    const t = new Date(e.at).getTime();
    return t >= win.lo && t <= win.hi;
  }), [callLog, win]);
  const winLabel = period === 'all' ? `Latest ${fmtInt(cases.length)} cases`
    : period === 'day' ? `${fmtInt(cases.length)} cases opened today`
    : period === 'week' ? `${fmtInt(cases.length)} cases opened this week`
    : period === 'month' ? `${fmtInt(cases.length)} cases opened this month`
    : `${fmtInt(cases.length)} cases ${from || '…'} → ${to || 'today'}`;
  // Calls in the window; falls back to per-case counts for sessions loaded
  // before timestamps rode along.
  const callsN = calls.length
    || cases.reduce((s, c) => s + Math.max(1, callsByCase[c.id] ?? 1), 0);

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
    // BOM so Excel decodes UTF-8 instead of the ANSI codepage.
    const blob = new Blob(['﻿' + [head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
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
          <h3>Helpline reporting</h3>
          <div className="meta">{winLabel} · confirmed →
            enrolled is the promise; every outcome verified against HMIS data</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          justifyContent: 'flex-end', minWidth: 0 }}>
          <span className="vseg" role="group" aria-label="Reporting window">
            {([['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All'],
               ['custom', 'Custom']] as const).map(([k, lbl]) => (
              <button key={k} type="button" className={period === k ? 'on' : undefined}
                onClick={() => setPeriod(k)}>{lbl}</button>
            ))}
          </span>
          {period === 'custom' && (
            <span className="dgroup">
              <input type="date" value={from} aria-label="Report from date"
                onClick={(e) => e.currentTarget.showPicker?.()}
                onChange={(e) => setFrom(e.target.value)} />
              <span className="dsep">→</span>
              <input type="date" value={to} aria-label="Report to date"
                onClick={(e) => e.currentTarget.showPicker?.()}
                onChange={(e) => setTo(e.target.value)} />
              {(from || to) && (
                <button type="button" className="dclr" title="Clear dates" aria-label="Clear dates"
                  onClick={() => { setFrom(''); setTo(''); }}>✕</button>
              )}
            </span>
          )}
          <Link href="/dashboard/helpline/report" className="tbtn"
            title="Board-ready monthly report — print or save as PDF"><IconPrinter size={11} /> Monthly report</Link>
          <button className="tbtn" onClick={downloadCsv}><IconDownload size={11} /> CSV</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
        gap: 14, padding: '4px 18px 16px' }}>
      <Funnel cases={cases} callsN={callsN} />
      <WeeklyTrend cases={cases} />
      <SlaCard cases={cases} rules={rules} />
      <BandQa cases={cases} rules={rules} />
      <DemandHeat calls={calls} />
      <ZipHeat cases={cases} callsByCase={callsByCase} />
      <Districts cases={cases} />
      <Breakdown cases={cases} teams={teams} rules={rules} />
      <CoverageGaps cases={cases} teams={teams} />
      <FactorMix cases={cases} rules={rules} />
      <HmisMix cases={cases} hmis={hmis} />
      <TriesFunnel cases={cases} events={events} />
      <RepeatPressure cases={cases} callsByCase={callsByCase} />
      <FamilyStats cases={cases} />
      <ReferBounce cases={cases} pool={allCases} />
      {(() => {
        // SOP external referrals — right-door diversion stats by destination
        // (user report 2026-08-25: the one-line tally wasn't enough to "check
        // stats"). Counts come from the loaded cases, same as the team table.
        const ro = cases.filter((c) => c.status === 'referred_out');
        if (!ro.length) return null;
        const now = Date.now();
        const by = new Map<string, { total: number; d30: number; last: string }>();
        for (const c of ro) {
          const k = c.referred_to ?? '(unspecified)';
          const e = by.get(k) ?? { total: 0, d30: 0, last: '' };
          e.total += 1;
          if (now - new Date(c.created_at).getTime() < 30 * 86_400_000) e.d30 += 1;
          const d = c.created_at.slice(0, 10);
          if (d > e.last) e.last = d;
          by.set(k, e);
        }
        const refRows = [...by.entries()].sort((a, b) => b[1].total - a[1].total);
        return (
          <ReportCard title="↗ External referrals — right-door diversions">
            <table className="bnl-table" style={{ maxWidth: 660 }}>
              <thead><tr>
                <th>Destination</th><th className="num">Total</th>
                <th className="num">Last 30d</th><th className="num">Most recent</th>
              </tr></thead>
              <tbody>
                {refRows.map(([k, v]) => (
                  <tr key={k} style={{ cursor: 'default' }}>
                    <td>{k}</td>
                    <td className="num">{fmtInt(v.total)}</td>
                    <td className="num">{v.d30 ? fmtInt(v.d30) : <span className="bnl-sub">—</span>}</td>
                    <td className="num">{v.last}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ReportCard>
        );
      })()}
      <ReportCard title="Team performance" span>
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
      </ReportCard>
      </div>
    </div>
  );
}

/**
 * Admin priority-rules editor (helpline_priority.sql, single row id=1).
 * Every knob the queue scoring reads: per-answer point weights, band
 * thresholds, waiting-time aging (entered in DAYS), repeat-call and
 * HMIS-chronic boosts, SLA target, and the emergency event toggle. Saves
 * write an immutable audit row — priorities drive dispatch decisions.
 */
function PriorityRulesAdmin({ me, rules, onSaved }: {
  me: string; rules: PriorityRules; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [w, setW] = useState<PriorityRules>(rules);
  useEffect(() => { if (!open) setW(rules); }, [rules, open]);
  const [log, setLog] = useState<{ changed_at: string; change: string }[] | null>(null);
  useEffect(() => {
    if (!open || log !== null) return;
    supabaseBrowser().from('helpline_priority_log')
      .select('changed_at, change').order('changed_at', { ascending: false }).limit(5)
      .then(({ data }) => setLog((data ?? []) as { changed_at: string; change: string }[]));
  }, [open, log]);

  const num = (v: number, set: (n: number) => void, width = 52) => (
    <input className="tinput" type="number" value={v} step={1}
      style={{ width, textAlign: 'center', padding: '4px 6px' }}
      onChange={(e2) => set(Number(e2.target.value) || 0)} />
  );
  const wRow = (label: string, v: number, set: (n: number) => void) => (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', gap: 8, fontSize: 12.5 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>{num(v, set)}
    </div>
  );

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    const payload = {
      id: 1,
      weights: { factors: w.factors, household: w.household, sleeping: w.sleeping,
        repeat_call: w.repeatCall, hmis_chronic: w.hmisChronic },
      bands: w.bands,
      aging: w.aging,
      sla_hours: w.slaHours,
      emergency: w.emergency,
      updated_at: new Date().toISOString(),
      updated_by: me,
    };
    const db2 = supabaseBrowser();
    const { error } = await db2.from('helpline_priority').upsert(payload);
    if (!error) {
      await db2.from('helpline_priority_log').insert({
        changed_by: me,
        change: JSON.stringify({ weights: payload.weights, bands: w.bands, aging: w.aging,
          sla_hours: w.slaHours, emergency: w.emergency }),
      });
    }
    setBusy(false);
    if (error) { setErr(`${error.message} — run supabase/helpline_priority.sql if this is a missing-table error.`); return; }
    setSaved(true); setLog(null); onSaved();
  }

  const preview = priorityOf(['Fleeing DV'], null, 'Street / outside', w);
  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-h">
        <div>
          <h3>Priority rules (admin)</h3>
          <div className="meta">Point weights, waiting-time escalation, boosts, response target,
            emergency mode · changes re-rank the queue instantly · every save is logged</div>
        </div>
        <button className="tbtn" onClick={() => { setOpen(!open); setSaved(false); }}>
          {open ? 'Close' : 'Edit rules'}</button>
      </div>
      {open && (
        <div style={{ padding: '0 18px 16px' }}>
          {err && <div className="lerror" role="alert" style={{ marginBottom: 10 }}>{err}</div>}
          {saved && <div role="status" style={{ marginBottom: 10, background: 'var(--accent-light)',
            color: 'var(--accent)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5,
            fontWeight: 600 }}>✓ Saved — the queue is already using the new rules.</div>}
          <div className="bnl-sub" style={{ fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.05em', margin: '4px 0 6px' }}>Points per answer</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '4px 22px' }}>
            {FACTORS.map((f2) => wRow(f2.key, w.factors[f2.key] ?? 0,
              (n) => setW({ ...w, factors: { ...w.factors, [f2.key]: n } })))}
            {HOUSEHOLD_OPTIONS.map((h) => wRow(`Household: ${h}`, w.household[h] ?? 0,
              (n) => setW({ ...w, household: { ...w.household, [h]: n } })))}
            {SLEEPING_OPTIONS.map((s) => wRow(`Slept: ${s}`, w.sleeping[s] ?? 0,
              (n) => setW({ ...w, sleeping: { ...w.sleeping, [s]: n } })))}
          </div>
          <div className="bnl-sub" style={{ fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.05em', margin: '14px 0 6px' }}>Escalation &amp; boosts</div>
          <div style={{ display: 'flex', gap: '8px 26px', flexWrap: 'wrap', fontSize: 12.5,
            alignItems: 'center', color: 'var(--muted)' }}>
            <span>Waiting adds {num(w.aging.pts, (n) => setW({ ...w, aging: { ...w.aging, pts: n } }), 44)} pt(s)
              every {num(Math.round(w.aging.hours / 24) || 1, (n) => setW({ ...w, aging: { ...w.aging, hours: Math.max(1, n) * 24 } }), 44)} day(s),
              max {num(w.aging.cap, (n) => setW({ ...w, aging: { ...w.aging, cap: n } }), 44)}</span>
            <span>Repeat call +{num(w.repeatCall, (n) => setW({ ...w, repeatCall: n }), 44)} per prior call (max 3)</span>
            <span title="Confirmed HMIS match who is chronic on the By-Name List">HMIS chronic +{num(w.hmisChronic, (n) => setW({ ...w, hmisChronic: n }), 44)}</span>
          </div>
          <div className="bnl-sub" style={{ fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.05em', margin: '14px 0 6px' }}>Bands &amp; response target</div>
          <div style={{ display: 'flex', gap: '8px 26px', flexWrap: 'wrap', fontSize: 12.5,
            alignItems: 'center', color: 'var(--muted)' }}>
            <span>HIGH at {num(w.bands.high, (n) => setW({ ...w, bands: { ...w.bands, high: n } }), 44)} pts</span>
            <span>MED at {num(w.bands.med, (n) => setW({ ...w, bands: { ...w.bands, med: n } }), 44)} pts</span>
            <span>
              <label style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={w.slaHours != null}
                  onChange={(e2) => setW({ ...w, slaHours: e2.target.checked ? 24 : null })} />
                {' '}Response target
              </label>
              {w.slaHours != null && <> {num(w.slaHours, (n) => setW({ ...w, slaHours: Math.max(1, n) }), 44)} hours</>}
            </span>
          </div>
          <div className="bnl-sub" style={{ fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '.05em', margin: '14px 0 6px' }}>Emergency mode</div>
          <div style={{ display: 'flex', gap: '8px 18px', flexWrap: 'wrap', fontSize: 12.5,
            alignItems: 'center', color: 'var(--muted)' }}>
            <label style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={w.emergency.active}
                onChange={(e2) => setW({ ...w, emergency: { ...w.emergency, active: e2.target.checked } })} />
              {' '}Active — boosts callers sleeping outside or in a car
            </label>
            <input className="tinput" style={{ width: 220 }} maxLength={60} value={w.emergency.label}
              placeholder="Event label — e.g. Heat advisory"
              onChange={(e2) => setW({ ...w, emergency: { ...w.emergency, label: e2.target.value } })} />
            <span>+{num(w.emergency.pts, (n) => setW({ ...w, emergency: { ...w.emergency, pts: n } }), 44)} pts</span>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn primary" style={{ padding: '6px 16px', fontSize: 12.5 }}
              disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rules'}</button>
            <span className="bnl-sub">
              Preview: fleeing DV + sleeping outside = {preview} pts = {priorityBand(preview, w)}
            </span>
          </div>
          {log && log.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="bnl-sub" style={{ fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '.05em', marginBottom: 4 }}>Recent changes</div>
              {log.map((l, i) => (
                <div key={i} className="bnl-sub" style={{ padding: '2px 0', overflowWrap: 'anywhere' }}>
                  {new Date(l.changed_at).toLocaleString()} · {l.change.slice(0, 160)}{l.change.length > 160 ? '…' : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
    initial: '☎ initial call', repeat: '☎ repeat call', followup: '📝 note',
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
          <Link className="tbtn" href={`/dashboard/helpline/print/${c.id}`} target="_blank"><IconPrinter size={11} /> Sheet</Link>
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
            {[c.sleeping, c.household, c.household_size ? `${c.household_size} in household` : null,
              ...(c.factors ?? [])].filter(Boolean).join(' · ') || '—'}
            <span className="bnl-sub"> · priority {c.priority} pts</span>
          </Row>
          {c.referred_to && <Row k="Referred to">↗ {c.referred_to}</Row>}
          {c.matched_pid && <Row k="HMIS"><CopyId id={c.matched_pid} /></Row>}
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
