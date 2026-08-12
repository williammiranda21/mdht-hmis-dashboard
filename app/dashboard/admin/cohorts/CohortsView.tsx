'use client';

import React, { useEffect, useRef, useState } from 'react';
import { fmtInt } from '../../../../lib/format';
import CopyId from '../../../../components/CopyId';
import JourneyBar from '../../../../components/JourneyBar';
import ClientDrawer from '../../bnl/ClientDrawer';
import { MILESTONES, type BnlClient } from '../../bnl/types';

/**
 * Client cohorts — create a named group, paste hashed PersonalIDs (every ID
 * in the app is click-to-copy, so any worklist/fix-list/drill becomes a
 * cohort), then track the group's housing outcomes over time. Metrics are
 * LIVE from bnl_clients; the trend comes from cohort_snapshots (one point
 * per refresh, pipeline/snapshot_cohorts.py). Membership is static — housed
 * clients stay, that's the point.
 */

/** Milestone order + labels come from the shared BNL registry (bnl/types.ts),
 *  so a future milestone added there flows into this bar untouched. */
const MS_ORDER = MILESTONES.map(([k]) => k);
const MS_LABELS = Object.fromEntries(MILESTONES);

const DAY_MS = 86400000;
/** Layer-1 stall thresholds (days) — arithmetic, not judgment: a member is
 *  QUIET after this many days without a note; an open next-step is stale
 *  after this many days. */
const NOTE_STALL_D = 14;
const STEP_STALL_D = 14;

/** '2026-08-05' → 'today' / '3d' / '2mo' — freshness for the notes column
 *  (same helper as the BNL roster). */
function noteAge(at: string): string {
  const d = Math.max(0, Math.floor((Date.now() - +new Date(`${at}T00:00:00`)) / 86400000));
  return d === 0 ? 'today' : d < 30 ? `${d}d` : d < 365 ? `${Math.round(d / 30)}mo` : `${Math.round(d / 365)}y`;
}

// ── monday-style people avatars ──────────────────────────────────────────────
// Round initials chip, color picked deterministically from the person's id so
// the same account is always the same color, everywhere on the page.
const AV_COLORS = ['#7E67FE', '#00a37a', '#e8912d', '#d64c62', '#2f8ac9', '#9a5cc9', '#4c9f70', '#c0699f'];
function avColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '')).toUpperCase();
}
// (The TAG_RULES keyword tagger that labeled completed next-steps lived here
// until 2026-08-12 — it served the deterministic "Since first note" ledger,
// which the AI case summary replaced. Recover from git history if needed.)

function Avatar({ name, id, size = 24 }: { name: string | null; id: string; size?: number }) {
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: avColor(id), color: '#fff',
      fontSize: size * 0.42, fontWeight: 700, letterSpacing: '.02em',
      lineHeight: 1, userSelect: 'none',
    }}>{initials(name)}</span>
  );
}
/** The "nobody yet" slot — dashed empty circle, monday-style. */
function AvatarEmpty({ size = 24 }: { size?: number }) {
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: '1.5px dashed var(--muted)', color: 'var(--muted)',
      fontSize: size * 0.55, fontWeight: 500, lineHeight: 1, userSelect: 'none',
    }}>+</span>
  );
}

interface CohortRow { id: number; name: string; description: string | null; created_by: string | null; created_at: string; members: number }
interface Member {
  pid: string; name: string | null; age: number | null; status: string;
  project: string | null; ptype: string | null; enrolled: boolean;
  days_homeless: number | null; chronic: boolean; returned: boolean; risk_band: string | null;
  as_of: string | null;
  /** live CE worklist leg + days on it (ETL fields — same source as the bar) */
  ms_stage: string | null; ms_wait: number | null;
  /** last notes (bnl_notes enrichment, cap 5) — same shape as the BNL roster */
  notes2?: { body: string; author: string | null; at: string }[] | null;
  /** CE journey dates (ident/assessed/referred/accepted/movein) — movein feeds
   *  the digest's "housed this period" line */
  milestones: Record<string, string | null> | null;
  /** when this member was added to the cohort — anchor for per-client progress */
  added_at?: string | null;
}
interface Task {
  id: number; pid: string; body: string;
  /** [{id, name}] account snapshots — several assignees allowed */
  assignees: { id: string; name: string | null }[];
  status: 'open' | 'done';
  created_by: string | null; created_at: string;
  done_at: string | null; done_by: string | null;
}
/** AI Layer-2 pilot — shapes returned by /api/ai/summary. Proposals are
 *  SUGGESTIONS only; they become cohort_tasks exclusively through the same
 *  add_task path as the manual form, when a human clicks + Add. */
interface AiProposal { body: string; rationale: string; source_date: string | null }
interface AiResult {
  summary: string | null;
  proposals: AiProposal[];
  model?: string;
  created_at?: string;
  /** false = the thread changed since this summary was written */
  current: boolean;
  cached: boolean;
  /** false = ai_summaries.sql not run yet — summaries won't persist */
  cacheOk?: boolean;
}
/** `bnl_access` is only meaningful for NON-admins — can_see_bnl() is
 *  is_admin() OR (approved AND bnl_access), so an admin with the flag off
 *  still sees everything. Always check is_admin before warning on it. */
interface Staff { id: string; display_name: string | null; email: string | null; bnl_access: boolean; is_admin: boolean }
interface Detail {
  cohort: { id: number; name: string; description: string | null; created_by: string | null; created_at: string };
  members: Member[];
  missing: string[];
  /** null → cohort_tasks.sql not run yet (setup hint) */
  tasks: Task[] | null;
  /** per-member note timestamps from the last 30 days (Layer-1 digest input) */
  noteDates: Record<string, string[]>;
  /** per-member FIRST note timestamp ever — the case-start anchor */
  firstNote: Record<string, string>;
  access: { user_id: string; granted_at: string }[] | null;
  staff: Staff[];
  manage: boolean;
  /** members exist but every row was RLS-filtered → viewer lacks BNL access */
  restricted?: boolean;
  snapshots: { captured_on: string; counts: { housed_pct?: number | null; n?: number } }[];
  agg: {
    n: number; active: number; housed: number; inactive: number;
    housed_pct: number | null; returned: number; chronic: number; high_risk: number;
    median_days_homeless: number | null;
    legs: Record<string, { n: number; median: number | null; mean: number | null }>;
    waiting: Record<string, { n: number; median: number | null; mean: number | null }>;
    /** weekly housed % by ACTUAL event dates (placements/returns), not refresh dates */
    housed_curve?: { d: string; pct: number; n: number }[];
    /** did the housing stick — from each member's FIRST placement */
    retention?: {
      placed_n: number; returned_n: number; median_days_to_return: number | null;
      horizons: { days: number; n: number; kept: number; pct: number | null }[];
    };
    /** system-wide journey legs (meta.ce_milestones.housed) — the ghost figures */
    sys_legs?: Record<string, { n: number; median: number | null; mean?: number | null }> | null;
  };
}

export default function CohortsView({ isAdmin = false, viewerId = null }:
    { isAdmin?: boolean; viewerId?: string | null }) {
  const [cohorts, setCohorts] = useState<CohortRow[] | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [paste, setPaste] = useState('');
  // Add-clients paste box is COLLAPSED by default (user report 2026-08-12:
  // the always-open textarea + access row stole ~90px from the member list).
  const [addOpen, setAddOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Member click → the SAME client card as the BNL (ClientDrawer). The member
  // row is slim, so fetch the full roster row by pid first.
  const [drill, setDrill] = useState<BnlClient | null>(null);
  const [drillAsOf, setDrillAsOf] = useState<string | null>(null);
  // Journey-bar worklist: clicking "N waiting" filters the member table to
  // that leg, longest-waiting first (same behavior as the BNL page).
  const [fStage, setFStage] = useState('');
  useEffect(() => setFStage(''), [sel]);   // a stage filter never outlives its cohort
  // Layer-1 activity digest window (days)
  const [digestWin, setDigestWin] = useState(7);
  // Notes hover card (same fixed-panel pattern as the BNL roster).
  const [notePop, setNotePop] = useState<{
    x: number; y: number; name: string;
    notes: NonNullable<Member['notes2']>;
  } | null>(null);
  // Next-steps panel: which member's task list is expanded, + the add form.
  const [openTasks, setOpenTasks] = useState<string | null>(null);
  const [taskText, setTaskText] = useState('');
  // draft assignees for the add form — several allowed (user request)
  const [taskAssignees, setTaskAssignees] = useState<string[]>([]);
  // monday-style people picker (fixed popover; fixed so .scroll-pin can't clip
  // it). mode 'draft' = picking for the add form · 'task' = reassigning an
  // existing task (admin) · 'access' = sharing the cohort (instant grant/revoke)
  const [peoplePick, setPeoplePick] = useState<{ x: number; y: number; mode: 'draft' | 'task' | 'access'; taskId?: number } | null>(null);
  useEffect(() => { setOpenTasks(null); setTaskText(''); setTaskAssignees([]); setPeoplePick(null); setAddOpen(false); }, [sel]);
  // ── AI Layer-2 pilot (per-member summary card in the expanded panel) ──────
  const [ai, setAi] = useState<Record<string, AiResult>>({});
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<Record<string, string>>({});
  // proposals already accepted this session, keyed `${pid}|${index}`
  const [aiAdded, setAiAdded] = useState<Record<string, boolean>>({});
  // admin audit view: the exact de-identified payload that would be sent
  const [aiPeek, setAiPeek] = useState<{ pid: string; json: string } | null>(null);
  useEffect(() => { setAi({}); setAiErr({}); setAiAdded({}); setAiPeek(null); }, [sel]);

  /** generate:false = cache lookup only (free, no API call) — used on expand.
   *  generate:true = the Generate/Refresh button; one Claude call, cached by
   *  input hash server-side so an unchanged thread is never re-billed. */
  const aiFetch = async (pid: string, generate: boolean) => {
    if (generate) { setAiBusy(pid); setAiErr((e) => ({ ...e, [pid]: '' })); }
    try {
      const r = await fetch('/api/ai/summary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, generate }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (generate) setAiErr((e) => ({ ...e, [pid]: String(j?.error ?? `Failed (${r.status}).`) }));
        else setAi((a) => ({ ...a, [pid]: { summary: null, proposals: [], current: false, cached: false } }));
        return;
      }
      setAi((a) => ({
        ...a,
        [pid]: {
          summary: j.summary ?? null, proposals: j.proposals ?? [],
          model: j.model, created_at: j.created_at,
          current: !!j.current, cached: !!j.cached, cacheOk: j.cacheOk,
        },
      }));
    } catch {
      if (generate) setAiErr((e) => ({ ...e, [pid]: 'Could not reach the AI service.' }));
    } finally {
      if (generate) setAiBusy((b) => (b === pid ? null : b));
    }
  };

  const aiPreview = async (pid: string) => {
    if (aiPeek?.pid === pid) { setAiPeek(null); return; }
    try {
      const r = await fetch('/api/ai/summary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, preview: true }),
      });
      const j = await r.json();
      if (r.ok) setAiPeek({ pid, json: JSON.stringify(j.payload, null, 2) });
    } catch { /* audit view is best-effort */ }
  };
  // Auto-collapse an idle Next-steps panel (user request): any activity inside
  // it resets the clock; a non-empty draft or an open people picker counts as
  // activity, so nothing in progress is ever swallowed. Refs (not state) so
  // mousemoves don't re-render.
  // 60s (was 20s): the panel now carries an AI summary worth READING, and
  // reading emits no DOM events — 20s closed it mid-sentence (user report
  // 2026-08-12). Additionally, a pointer parked anywhere over the panel
  // holds it open indefinitely (panelHoverRef below).
  const TASKS_IDLE_MS = 60_000;
  const tasksTouchRef = useRef(Date.now());
  const draftRef = useRef(false);
  const panelHoverRef = useRef(false);
  useEffect(() => {
    // An in-flight AI generation counts as activity too — the 20s idle
    // collapse must never swallow the panel under a "Generating…" spinner
    // (caught in verification: the Claude call runs 10-15s, close to the
    // idle threshold).
    draftRef.current = taskText.trim().length > 0 || taskAssignees.length > 0
      || peoplePick !== null || aiBusy !== null;
  }, [taskText, taskAssignees, peoplePick, aiBusy]);
  const touchTasks = () => { tasksTouchRef.current = Date.now(); };
  useEffect(() => {
    if (!openTasks) return;
    tasksTouchRef.current = Date.now();
    const iv = setInterval(() => {
      if (draftRef.current || panelHoverRef.current) { tasksTouchRef.current = Date.now(); return; }
      if (Date.now() - tasksTouchRef.current >= TASKS_IDLE_MS) {
        setOpenTasks(null); setPeoplePick(null);
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [openTasks]);
  // Click-away close (user request): any mousedown OUTSIDE the tasks UI —
  // the chip cell, the expanded panel, or the people menu, all marked with
  // data-tasks-ui — collapses the panel. mousedown (not click) so it fires
  // before the chip's own toggle and doesn't fight it.
  useEffect(() => {
    if (!openTasks) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-tasks-ui]')) return;
      // An in-progress draft (typed text, picked assignees, or an open people
      // menu) is never swallowed by click-away — same guard as the idle timer.
      if (draftRef.current) return;
      setOpenTasks(null); setPeoplePick(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openTasks]);

  async function openMember(m: Member) {
    try {
      const r = await fetch(`/api/bnl/roster?pid=${encodeURIComponent(m.pid)}&limit=1`);
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { rows: BnlClient[] };
      if (j.rows[0]) { setDrillAsOf(m.as_of); setDrill(j.rows[0]); }
      else setMsg('Client is no longer on the By-Name List roster.');
    } catch {
      setMsg('Could not load the client card.');
    }
  }

  const loadList = () => {
    fetch('/api/cohorts')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setCohorts(j.cohorts ?? []))
      .catch(() => { setCohorts([]); setSetupNeeded(true); });
  };
  useEffect(loadList, []);

  const loadDetail = (id: number) => {
    setSel(id); setDetail(null); setMsg(null);
    fetch(`/api/cohorts?id=${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setDetail)
      .catch(() => setMsg('Could not load this cohort.'));
  };

  // In-place refresh after task/note/access mutations — patches only what
  // those can change (tasks, access, note timestamps, last-note previews)
  // into the existing detail. No setDetail(null), so the page never flashes
  // "Loading…" just because a checkbox-sized thing changed (user report).
  const refreshLite = async () => {
    if (sel == null) return;
    try {
      const r = await fetch(`/api/cohorts?id=${sel}&scope=tasks`);
      if (!r.ok) return;
      const j = await r.json() as {
        tasks: Task[] | null;
        access: { user_id: string; granted_at: string }[] | null;
        noteDates: Record<string, string[]>;
        notes2: Record<string, NonNullable<Member['notes2']>>;
        firstNote: Record<string, string>;
      };
      setDetail((d) => d ? {
        ...d,
        tasks: j.tasks,
        access: j.access,
        noteDates: j.noteDates ?? d.noteDates,
        firstNote: j.firstNote ?? d.firstNote,
        members: d.members.map((m) => ({ ...m, notes2: j.notes2?.[m.pid] ?? m.notes2 ?? null })),
      } : d);
    } catch { /* keep the current view — next full load reconciles */ }
  };

  const act = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/cohorts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      let m = `Failed (${r.status}).`;
      try { const j = await r.json(); if (j?.error) m = String(j.error); } catch { /* keep default */ }
      setMsg(m);
      return null;
    }
    return r.json();
  };

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Client cohorts</h3>
            <div className="meta">
              {isAdmin
                ? <>Create a group, paste client IDs (every ID in the app is click-to-copy), and track
                    the group&apos;s housing outcomes. Membership is static — clients stay after they&apos;re
                    housed; that&apos;s what makes the trend meaningful. Share a cohort with staff via
                    its Access panel.</>
                : <>Cohorts shared with you. Open one to see its members, meeting notes, and your
                    next-step assignments.</>}
            </div>
          </div>
        </div>
        <div style={{ padding: '2px 18px 18px' }}>
          {setupNeeded && (
            <div className="bnl-dq" style={{ marginBottom: 12 }}>
              One-time setup: run <code>supabase/cohorts.sql</code> in the Supabase SQL editor, then reload.
            </div>
          )}
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
              <input className="finput" placeholder="New cohort name…" value={name}
                onChange={(e) => setName(e.target.value)} style={{ minWidth: 200 }} />
              <input className="finput" placeholder="Description (optional)" value={desc}
                onChange={(e) => setDesc(e.target.value)} style={{ minWidth: 260 }} />
              <button className="btn" disabled={busy || !name.trim()} onClick={async () => {
                const r = await act({ action: 'create', name, description: desc });
                if (r?.ok) { setName(''); setDesc(''); loadList(); loadDetail(Number(r.id)); }
              }}>+ Create cohort</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(cohorts ?? []).map((c) => (
              <button key={c.id} className="btn" aria-pressed={sel === c.id}
                style={sel === c.id ? { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' } : undefined}
                onClick={() => loadDetail(c.id)}>
                {c.name} <span style={{ opacity: .75 }}>({fmtInt(c.members)})</span>
              </button>
            ))}
            {cohorts !== null && cohorts.length === 0 && !setupNeeded && (
              <span className="bnl-sub">
                {isAdmin ? 'No cohorts yet — create the first one above.' : 'No cohorts have been shared with you yet.'}
              </span>
            )}
          </div>
          {msg && <div className="bnl-dq" style={{ marginTop: 10 }}>{msg}</div>}
        </div>
      </div>

      {sel != null && detail && (
        <>
          <div className="bnl-kpis" style={{ marginTop: 16 }}>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--primary)' }}>
              <div className="bnl-kpi-lbl">Members</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.n)}</div>
              <div className="bnl-kpi-note">since {detail.cohort.created_at.slice(0, 10)}</div>
            </div>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--accent)' }}>
              <div className="bnl-kpi-lbl">Housed</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.housed)}</div>
              <div className="bnl-kpi-note">{detail.agg.housed_pct == null ? '—' : `${detail.agg.housed_pct.toFixed(0)}% of cohort`}</div>
            </div>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--warn)' }}>
              <div className="bnl-kpi-lbl">Actively homeless</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.active)}</div>
              <div className="bnl-kpi-note">{detail.agg.median_days_homeless != null ? `median ${fmtInt(detail.agg.median_days_homeless)}d homeless` : '—'}</div>
            </div>
            <div className="bnl-kpi" style={{ ['--kc' as never]: 'var(--danger)' }}>
              <div className="bnl-kpi-lbl">Returned after housing</div>
              <div className="bnl-kpi-val num">{fmtInt(detail.agg.returned)}</div>
              <div className="bnl-kpi-note">{fmtInt(detail.agg.chronic)} chronic · {fmtInt(detail.agg.high_risk)} high risk</div>
            </div>
          </div>

          {/* Cohort CE journey — the same proportional bar as the BNL system
              card (components/JourneyBar), fed by this cohort's members only:
              completed legs above the bar, members stuck on each leg below. */}
          <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
            <div className="hc-sub" style={{ margin: '0 0 10px' }}>
              Cohort CE journey — median days between milestones
              <span className="bnl-sub" style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                this cohort&apos;s members only
              </span>
            </div>
            <JourneyBar order={MS_ORDER} labels={MS_LABELS}
                        housed={detail.agg.legs} waiting={detail.agg.waiting ?? {}}
                        benchmark={detail.agg.sys_legs}
                        onLegClick={(k) => setFStage(k)} />
            {detail.agg.legs['ident_movein']?.median != null && (
              <div className="bnl-sub" style={{ marginTop: 6 }}>
                End to end {MS_LABELS['ident'] ?? 'Identified'} → {MS_LABELS['movein'] ?? 'Moved in'}:{' '}
                <b style={{ color: 'var(--strong)' }}>{fmtInt(detail.agg.legs['ident_movein'].median!)}d</b> median
                {detail.agg.legs['ident_movein'].mean != null && <> · avg {Math.round(detail.agg.legs['ident_movein'].mean!)}d</>}
                {' '}(n={detail.agg.legs['ident_movein'].n})
                {detail.agg.sys_legs?.['ident_movein']?.median != null &&
                  <> · system {fmtInt(detail.agg.sys_legs['ident_movein'].median!)}d</>}
                {' '}· above each segment: completed legs · below: members on that leg right now, days so far
              </div>
            )}
          </div>

          {/* Trend — housed % by ACTUAL event dates (placements / HUD returns),
              reconstructed retroactively; refresh snapshots overlay as dots.
              A dot off the line = the data was edited after that capture
              (backdated move-in, corrected exit) — that divergence is signal.
              Falls back to the old snapshot bars when no placements exist. */}
          {(detail.agg.housed_curve?.length ?? 0) > 1 ? (() => {
            const pts = detail.agg.housed_curve!;
            const W = 860, H = 130, PAD = 8, LBL = 14;
            const t0 = +new Date(pts[0].d), t1 = +new Date(pts[pts.length - 1].d);
            const maxP = Math.max(10, ...pts.map((p) => p.pct),
              ...detail.snapshots.map((s) => s.counts.housed_pct ?? 0)) * 1.15;
            const sx = (d: string) => PAD + ((+new Date(d) - t0) / Math.max(t1 - t0, 1)) * (W - 2 * PAD);
            const sy = (p: number) => (H - LBL) - PAD - (p / maxP) * ((H - LBL) - 2 * PAD);
            const line = pts.map((p) => `${sx(p.d).toFixed(1)},${sy(p.pct).toFixed(1)}`).join(' ');
            const last = pts[pts.length - 1];
            return (
              <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
                <div className="hc-sub" style={{ margin: '0 0 10px' }}>
                  Housed % over time
                  <span className="bnl-sub" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                    by actual housing / return dates · ● = refresh snapshots (as measured)
                  </span>
                </div>
                <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 130, display: 'block' }} role="img"
                  aria-label={`Cohort housed percentage over time, currently ${last.pct.toFixed(0)}%`}>
                  {/* quarter gridlines */}
                  {[0.25, 0.5, 0.75].map((f) => (
                    <line key={f} x1={PAD} x2={W - PAD} y1={sy(maxP * f)} y2={sy(maxP * f)}
                      stroke="var(--faint)" strokeWidth={0.5} opacity={0.5} />
                  ))}
                  <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round" />
                  {detail.snapshots.map((s) => {
                    const pct = s.counts.housed_pct ?? 0;
                    return (
                      <circle key={s.captured_on} cx={sx(s.captured_on)} cy={sy(pct)} r={3.5}
                        fill="var(--primary)" stroke="var(--panel, #fff0)" strokeWidth={1}>
                        <title>{`snapshot ${s.captured_on}: ${pct.toFixed(0)}% housed (n=${s.counts.n ?? '—'})`}</title>
                      </circle>
                    );
                  })}
                  <text x={Math.min(sx(last.d), W - PAD - 4)} y={Math.max(sy(last.pct) - 6, 10)}
                    textAnchor="end" fontSize={11.5} fontWeight={700} fill="var(--strong)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {last.pct.toFixed(0)}%
                  </text>
                  <text x={PAD} y={H - 2} fontSize={9.5} fill="var(--muted)">{pts[0].d}</text>
                  <text x={W - PAD} y={H - 2} textAnchor="end" fontSize={9.5} fill="var(--muted)">{last.d}</text>
                </svg>
              </div>
            );
          })() : detail.snapshots.length > 0 && (
            <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
              <div className="hc-sub" style={{ margin: '0 0 20px' }}>Housed % over time <span className="bnl-sub" style={{ textTransform: 'none', letterSpacing: 0 }}>one point per data refresh</span></div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 84 }}>
                {detail.snapshots.map((s) => {
                  const pct = s.counts.housed_pct ?? 0;
                  return (
                    <div key={s.captured_on} title={`${s.captured_on}: ${pct.toFixed(0)}% housed (n=${s.counts.n ?? '—'})`}
                      style={{ flex: 1, maxWidth: 44, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(0)}%</span>
                      <span style={{ display: 'block', width: '100%', height: 4 + pct * 0.48, borderRadius: 3, background: 'var(--accent)', opacity: .9 }} />
                      <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>{s.captured_on.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Returns after first housing — HUD M2 framing (first placement,
              returns within windows; a later re-housing does NOT erase the
              return — that is exactly how the SPM counts it). Framed as the
              EVENT ("N returned within…"), never as "retention", because a
              member can be housed today AND have a counted return — a
              "retention 0%" read as current status started an argument
              (user, 2026-08-11). Denominators are censored: only first
              placements at least that old are gradeable. "Housed today"
              alongside keeps both truths on screen. */}
          {(detail.agg.retention?.placed_n ?? 0) > 0 && (() => {
            const rt = detail.agg.retention!;
            const H_LBL: Record<number, string> = { 180: '6 mo', 365: '12 mo', 730: '24 mo' };
            return (
              <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
                <div className="hc-sub" style={{ margin: '0 0 8px' }}>
                  Returns after first housing
                  <span className="bnl-sub" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                    HUD return test, from each member&apos;s first placement · re-housing later doesn&apos;t erase a return (SPM M2 convention)
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 13 }}>
                  {rt.horizons.map((h) => {
                    const returned = h.n - h.kept;
                    return (
                      <span key={h.days} title={h.n
                        ? `${h.n} first placement${h.n === 1 ? '' : 's'} old enough to grade at ${H_LBL[h.days]}; ${returned} had a HUD-qualifying return within that window`
                        : `no first placement is ${H_LBL[h.days]} old yet — nothing to grade`}>
                        <span className="bnl-sub">within {H_LBL[h.days] ?? `${h.days}d`}: </span>
                        {h.n
                          ? <><b style={{ fontVariantNumeric: 'tabular-nums', color: returned ? 'var(--warn)' : 'var(--accent)' }}>{returned}</b><span className="bnl-sub"> of {h.n} returned</span></>
                          : <span className="bnl-sub">— too soon</span>}
                      </span>
                    );
                  })}
                  <span className="bnl-sub" style={{ marginLeft: 'auto' }}>
                    {rt.returned_n
                      ? <>{rt.returned_n} return{rt.returned_n === 1 ? '' : 's'} overall{rt.median_days_to_return != null && <> · median {fmtInt(rt.median_days_to_return)}d after housing</>}</>
                      : 'no returns recorded'}
                    {' '}· <b style={{ color: 'var(--accent)' }}>{detail.agg.housed}</b> of {rt.placed_n} ever-housed are housed today
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Layer-1 deterministic activity digest — every number is arithmetic
              over timestamps already on this page (notes, task stamps, journey
              move-ins). Nothing inferred, everything defensible in a meeting. */}
          {(() => {
            const winStart = Date.now() - digestWin * DAY_MS;
            const tasks = detail.tasks ?? [];
            const notedMembers = new Set<string>();
            let noteCount = 0;
            for (const m of detail.members) {
              const n = (detail.noteDates?.[m.pid] ?? []).filter((d) => +new Date(d) >= winStart).length;
              if (n) { noteCount += n; notedMembers.add(m.pid); }
            }
            const doneWin = tasks.filter((t) => t.done_at && +new Date(t.done_at) >= winStart).length;
            const newWin = tasks.filter((t) => +new Date(t.created_at) >= winStart).length;
            const openStale = tasks.filter((t) => t.status === 'open'
              && Date.now() - +new Date(t.created_at) >= STEP_STALL_D * DAY_MS).length;
            const taskActive = new Set(tasks
              .filter((t) => +new Date(t.created_at) >= winStart || (t.done_at && +new Date(t.done_at) >= winStart))
              .map((t) => t.pid));
            const quiet = detail.members.filter((m) => m.status === 'active'
              && !notedMembers.has(m.pid) && !taskActive.has(m.pid));
            const housed = detail.members.filter((m) => {
              const mi = m.milestones?.movein;
              return mi && +new Date(`${mi}T00:00:00`) >= winStart;
            }).length;
            const byAssignee = new Map<string, { name: string | null; n: number; oldest: number }>();
            for (const t of tasks) {
              if (t.status !== 'open') continue;
              const age = Math.floor((Date.now() - +new Date(t.created_at)) / DAY_MS);
              for (const a of t.assignees ?? []) {
                const e = byAssignee.get(a.id) ?? { name: a.name, n: 0, oldest: 0 };
                e.n += 1; e.oldest = Math.max(e.oldest, age);
                byAssignee.set(a.id, e);
              }
            }
            return (
              <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
                <div className="hc-sub" style={{ margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  Activity — last {digestWin} days
                  <span style={{ display: 'inline-flex', gap: 2 }}>
                    {[7, 14, 30].map((w) => (
                      <button key={w} className="tbtn" aria-pressed={digestWin === w}
                        style={digestWin === w ? { color: 'var(--primary)', fontWeight: 700 } : undefined}
                        onClick={() => setDigestWin(w)}>{w}d</button>
                    ))}
                  </span>
                  <span className="bnl-sub" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                    computed from note, next-step, and move-in timestamps — nothing inferred
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13, alignItems: 'baseline' }}>
                  <span>
                    <b className="num">{noteCount}</b> note{noteCount === 1 ? '' : 's'} on{' '}
                    <b className="num">{notedMembers.size}</b> member{notedMembers.size === 1 ? '' : 's'}
                  </span>
                  {detail.tasks !== null && (
                    <span>
                      <b className="num" style={{ color: 'var(--accent)' }}>{doneWin}</b> next-step{doneWin === 1 ? '' : 's'} completed
                      {' '}· <b className="num">{newWin}</b> created
                      {openStale > 0 && <> · <b className="num" style={{ color: 'var(--warn)' }}>{openStale}</b> open &gt;{STEP_STALL_D}d</>}
                    </span>
                  )}
                  {housed > 0 && (
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                      <b className="num">{housed}</b> moved into housing
                    </span>
                  )}
                  <span title={quiet.length ? quiet.map((m) => m.name ?? m.pid).join(', ') : undefined}
                    style={quiet.length ? { color: 'var(--warn)' } : undefined}>
                    <b className="num">{quiet.length}</b> active member{quiet.length === 1 ? '' : 's'} with no activity at all
                  </span>
                </div>
                {byAssignee.size > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    {[...byAssignee.entries()].sort((a, b) => b[1].n - a[1].n).map(([id, e]) => (
                      <span key={id} className="bnl-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        title={`${e.name ?? 'Unknown'} — ${e.n} open next-step${e.n === 1 ? '' : 's'}, oldest ${e.oldest}d`}>
                        <Avatar name={e.name} id={id} size={18} />
                        {(e.name ?? '?').split(' ')[0]} · {e.n} open{e.oldest >= STEP_STALL_D ? ` · ${e.oldest}d` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Members */}
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-h">
              <div>
                <h3>{detail.cohort.name} — members</h3>
                <div className="meta">
                  {detail.cohort.description || 'No description.'}
                  {detail.missing.length > 0 && ` · ⚠ ${detail.missing.length} member(s) no longer on the roster`}
                </div>
              </div>
              {isAdmin && (
                <button className="btn" disabled={busy} onClick={async () => {
                  if (!window.confirm(`Delete cohort “${detail.cohort.name}”? Members are not affected — only the grouping is removed.`)) return;
                  const r = await act({ action: 'delete', id: sel });
                  if (r?.ok) { setSel(null); setDetail(null); loadList(); }
                }}>Delete cohort</button>
              )}
            </div>

            {/* ONE compact toolbar row (user report 2026-08-12: the stacked
                Access row + always-open paste textarea stole ~90px from the
                member list). Access chips + Share on the left, the Add-clients
                TOGGLE at the right — the paste box itself only renders when
                toggled open below. */}
            {isAdmin && (
              <div style={{ padding: '0 18px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="flabel" style={{ margin: 0 }}>Access</span>
                {detail.access === null ? (
                  <span className="bnl-sub">run <code>supabase/cohort_tasks.sql</code> to enable sharing &amp; tasks</span>
                ) : (
                  <>
                    {detail.access.map((a) => {
                      const s = detail.staff.find((st) => st.id === a.user_id);
                      const nm = s?.display_name || s?.email || a.user_id.slice(0, 8);
                      const noBnl = s ? !s.is_admin && !s.bnl_access : false;
                      return (
                        <span key={a.user_id} className="bnl-chip"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                          title={noBnl
                          ? 'This account has no By-Name List access — they will see the cohort but not member names. Grant BNL access in the Users console.'
                          : undefined}>
                          <Avatar name={nm} id={a.user_id} size={18} />
                          {nm}{noBnl && ' ⚠'}
                          <span role="button" style={{ cursor: 'pointer', marginLeft: 6, opacity: .7 }}
                            title="Revoke access"
                            onClick={async () => {
                              const r = await act({ action: 'revoke_access', id: sel, user_id: a.user_id });
                              if (r?.ok) void refreshLite();
                            }}>✕</span>
                        </span>
                      );
                    })}
                    <button className="btn" data-tasks-ui=""
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      title="Share this cohort — click people in the list to grant or revoke, several in a row"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setPeoplePick(peoplePick?.mode === 'access' ? null : { x: rect.left, y: rect.bottom + 6, mode: 'access' });
                      }}>
                      + Share
                    </button>
                  </>
                )}
                <button className="btn" aria-expanded={addOpen}
                  style={{ marginLeft: 'auto',
                    ...(addOpen ? { borderColor: 'var(--primary)', color: 'var(--primary)' } : {}) }}
                  title="Paste hashed client IDs to add members (every ID in the app is click-to-copy)"
                  onClick={() => setAddOpen((v) => !v)}>
                  + Add clients {addOpen ? '▴' : '▾'}
                </button>
              </div>
            )}
            {detail.restricted && (
              <div style={{ padding: '0 18px 10px' }} className="bnl-sub">
                You have access to this cohort, but member details require By-Name List access —
                ask an administrator to enable it for your account.
              </div>
            )}
            {fStage && (
              <div style={{ padding: '0 18px 10px' }}>
                <button className="btn" onClick={() => setFStage('')}
                  title="Showing members stuck on this CE leg (from the journey bar), longest-waiting first. Click to clear.">
                  ⏳ Waiting at {MS_LABELS[fStage] ?? fStage} · {detail.members.filter((m) => m.ms_stage === fStage).length} member{detail.members.filter((m) => m.ms_stage === fStage).length === 1 ? '' : 's'} ✕
                </button>
              </div>
            )}
            {isAdmin && addOpen && (
              <div style={{ padding: '0 18px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <textarea className="finput" rows={2} autoFocus style={{ minWidth: 320, flex: 1 }}
                  placeholder="Paste hashed client IDs (one per line, or comma/space separated)…"
                  value={paste} onChange={(e) => setPaste(e.target.value)} />
                <button className="btn" disabled={busy || !paste.trim()} onClick={async () => {
                  const pids = paste.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
                  const r = await act({ action: 'add_members', id: sel, pids });
                  if (r?.ok) {
                    setPaste(''); setAddOpen(false);
                    setMsg(`Added ${r.added}.${(r.unknown as string[]).length ? ` Not on the roster (skipped): ${(r.unknown as string[]).join(', ')}` : ''}`);
                    loadDetail(sel!); loadList();
                  }
                }}>Add</button>
                <button className="btn" title="Close — a pasted draft is kept"
                  onClick={() => setAddOpen(false)}>✕</button>
              </div>
            )}
            <div className="scroll scroll-pin">
              <table>
                <thead>
                  <tr>
                    <th>Client</th><th className="num">Age</th><th>Status</th><th>Project</th>
                    <th className="num">Days homeless</th><th className="num">CE leg wait</th><th>Flags</th>
                    <th>Last note</th><th>Next steps</th><th className="num"></th>
                  </tr>
                </thead>
                <tbody>
                  {(fStage
                    ? detail.members.filter((m) => m.ms_stage === fStage)
                        .sort((a, b) => (b.ms_wait ?? 0) - (a.ms_wait ?? 0))
                    : detail.members
                  ).map((m) => {
                    const mTasks = (detail.tasks ?? []).filter((t) => t.pid === m.pid);
                    const openN = mTasks.filter((t) => t.status === 'open').length;
                    const expanded = openTasks === m.pid;
                    // Layer-1 stall arithmetic: days since the newest note, and
                    // the age of the oldest still-open next-step.
                    const lastNoteAt = m.notes2?.[0]?.at ?? null;
                    const noteDays = lastNoteAt
                      ? Math.max(0, Math.floor((Date.now() - +new Date(`${lastNoteAt}T00:00:00`)) / DAY_MS))
                      : null;
                    const quietFlag = m.status === 'active' && (noteDays === null || noteDays > NOTE_STALL_D);
                    const oldestOpen = mTasks.reduce((mx, t) => t.status === 'open'
                      ? Math.max(mx, Math.floor((Date.now() - +new Date(t.created_at)) / DAY_MS)) : mx, 0);
                    return (
                    /* row opens the shared client card; CopyId, the notes cell,
                       the tasks cell and the remove button stop propagation */
                    <React.Fragment key={m.pid}>
                    <tr onClick={() => openMember(m)} style={{ cursor: 'pointer' }}
                        title="Open client card">
                      <td>
                        <div className="bnl-nm bnl-drillname">{m.name ?? m.pid}</div>
                        <CopyId pid={m.pid} />
                      </td>
                      <td className="num">{m.age ?? '—'}</td>
                      <td><span className={`bnl-chip bnl-${m.status}`}>{m.status}</span></td>
                      <td>{m.ptype && <span className="ty">{m.ptype}</span>} {m.project ?? '—'}{!m.enrolled && m.project ? <span className="bnl-sub"> (former)</span> : ''}</td>
                      <td className="num">{m.days_homeless != null ? fmtInt(m.days_homeless) : '—'}</td>
                      <td className="num">{m.ms_wait != null
                        ? <>{fmtInt(m.ms_wait)}d <span className="bnl-sub">· {MS_LABELS[m.ms_stage ?? ''] ?? m.ms_stage}</span></>
                        : <span className="bnl-sub">—</span>}</td>
                      <td>
                        {m.chronic && <span className="bnl-fp bnl-fp-chr">CHRONIC</span>}
                        {m.returned && <span className="bnl-fp bnl-fp-ret">RETURNED</span>}
                        {m.risk_band === 'High' && <span className="bnl-fp bnl-fp-dq">HIGH RISK</span>}
                        {/* Layer-1 stall flags — each is a sentence with a number */}
                        {quietFlag && (
                          <span className="bnl-fp" style={{ background: 'rgba(234,179,8,0.14)', color: 'var(--warn)' }}
                            title={noteDays === null
                              ? 'No notes on file for this member'
                              : `No note in ${noteDays} days — the case has gone quiet`}>
                            {noteDays === null ? 'NO NOTES' : `QUIET ${noteDays}d`}
                          </span>
                        )}
                        {oldestOpen > STEP_STALL_D && (
                          <span className="bnl-fp" style={{ background: 'rgba(234,179,8,0.14)', color: 'var(--warn)' }}
                            title={`Oldest open next-step is ${oldestOpen} days old — assigned work nobody has closed`}>
                            STEP {oldestOpen}d
                          </span>
                        )}
                      </td>
                      {/* Last note — same treatment as the BNL roster column */}
                      <td style={{ maxWidth: 200 }}
                        onMouseEnter={(e) => {
                          if (!m.notes2?.length) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          setNotePop({ x: rect.left, y: rect.top, name: m.name ?? m.pid, notes: m.notes2 });
                        }}
                        onMouseLeave={() => setNotePop(null)}>
                        {(m.notes2?.length ?? 0)
                          ? (() => {
                              const latest = m.notes2![0];
                              const age = noteAge(latest.at);
                              const fresh = age === 'today' || age.endsWith('d');
                              return (
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, maxWidth: 200 }}>
                                  {m.notes2!.length > 1 && (
                                    <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                                      border: '1px solid rgba(148,163,184,0.35)', borderRadius: 8, padding: '0 5px' }}>
                                      {m.notes2!.length}{m.notes2!.length === 5 ? '+' : ''}
                                    </span>
                                  )}
                                  <span style={{ flexShrink: 0, fontSize: 11, fontVariantNumeric: 'tabular-nums',
                                    fontWeight: fresh ? 700 : 400,
                                    color: fresh ? 'var(--strong)' : 'var(--muted)' }}>{age}</span>
                                  <span className="bnl-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {latest.body}
                                  </span>
                                </div>
                              );
                            })()
                          : <span className="bnl-sub">—</span>}
                      </td>
                      {/* Next steps — option-B chip (user-picked mockup 2026-08-12):
                          a deliberate two-line card instead of the old one-liner that
                          wrapped into a jumble in this narrow column. Line 1 = the
                          assigned people with the open count at the right; line 2 =
                          status. Amber = open work · green = all done · dashed =
                          nothing yet. Expanded state shows as a primary border (the
                          old caret went with the wrap). */}
                      <td onClick={(e) => e.stopPropagation()} data-tasks-ui="">
                        {detail.tasks === null
                          ? <span className="bnl-sub" title="Run supabase/cohort_tasks.sql to enable">—</span>
                          : (() => {
                            // open work → the people on the OPEN items; all done →
                            // everyone who worked the member (so the stack survives)
                            const people: { id: string; name: string | null }[] = [];
                            for (const t of mTasks) {
                              if (openN > 0 && t.status !== 'open') continue;
                              for (const a of t.assignees ?? []) {
                                if (!people.some((p) => p.id === a.id)) people.push(a);
                              }
                            }
                            const state = openN ? 'open' : mTasks.length ? 'done' : 'empty';
                            const col = state === 'open' ? 'var(--warn)' : state === 'done' ? 'var(--accent)' : 'var(--muted)';
                            const line2 = state === 'open'
                              ? (oldestOpen > 0 ? `open · oldest ${oldestOpen}d` : 'open · new')
                              : state === 'done' ? 'all done' : 'add step';
                            return (
                              <button className="btn" aria-expanded={expanded}
                                style={{
                                  display: 'inline-flex', flexDirection: 'column', alignItems: 'stretch',
                                  gap: 3, padding: '5px 9px', minWidth: 88, fontSize: 12,
                                  borderColor: expanded ? 'var(--primary)' : state === 'open' ? 'var(--warn)' : undefined,
                                  borderStyle: state === 'empty' ? 'dashed' : undefined,
                                }}
                                title={expanded ? 'Collapse next steps'
                                  : people.length
                                    ? `${state === 'open' ? 'Open items assigned to' : 'Worked by'} ${people.map((p) => p.name).filter(Boolean).join(', ')} — click for the checklist`
                                    : 'Show next steps for this member'}
                                onClick={() => {
                                  setOpenTasks(expanded ? null : m.pid); setTaskText(''); setTaskAssignees([]);
                                  // free cache lookup so a stored AI summary shows instantly on expand
                                  if (!expanded && !(m.pid in ai)) void aiFetch(m.pid, false);
                                }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                  {people.length > 0 ? (
                                    <span style={{ display: 'inline-flex' }}>
                                      {people.slice(0, 3).map((p, i) => (
                                        <span key={p.id} style={{ marginLeft: i ? -7 : 0, display: 'inline-flex',
                                          borderRadius: '50%', border: '1.5px solid var(--card)' }}>
                                          <Avatar name={p.name} id={p.id} size={20} />
                                        </span>
                                      ))}
                                      {people.length > 3 && (
                                        <span className="bnl-sub" style={{ marginLeft: 3, fontSize: 10.5, alignSelf: 'center' }}>
                                          +{people.length - 3}
                                        </span>
                                      )}
                                    </span>
                                  ) : <AvatarEmpty size={20} />}
                                  {state === 'open' && <span className="num" style={{ color: col, fontWeight: 700 }}>{openN}</span>}
                                  {state === 'done' && <span style={{ color: col, fontWeight: 700 }}>✓</span>}
                                </span>
                                <span style={{ color: col, fontSize: 11, whiteSpace: 'nowrap', textAlign: 'left' }}>{line2}</span>
                              </button>
                            );
                          })()}
                      </td>
                      <td className="num">
                        {isAdmin && (
                          <button className="btn" style={{ padding: '0 8px', fontSize: 12 }} title="Remove from cohort"
                            disabled={busy}
                            onClick={async (e) => {
                              e.stopPropagation();
                              const r = await act({ action: 'remove_member', id: sel, pid: m.pid });
                              if (r?.ok) { loadDetail(sel!); loadList(); }
                            }}>✕</button>
                        )}
                      </td>
                    </tr>
                    {expanded && detail.tasks !== null && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--card-top)', padding: '10px 18px 14px' }}
                          data-tasks-ui=""
                          onMouseEnter={() => { panelHoverRef.current = true; }}
                          onMouseLeave={() => { panelHoverRef.current = false; touchTasks(); }}
                          onMouseMove={touchTasks} onClick={touchTasks} onKeyDown={touchTasks}>
                          {/* AI case summary (Layer 2) — REPLACES the old deterministic
                              "Since first note" ledger (user call 2026-08-12): the
                              narrative IS the accomplishments-since-start view now; the
                              deterministic start-date anchor stays in the header. Claude
                              reads the DE-IDENTIFIED thread (lib/ai/deidentify strips
                              names/SSN/phone/email/DOB server-side before any API call;
                              hashed pid is the only identifier sent). Cached by input
                              hash, so an unchanged thread never re-bills. AI PROPOSES,
                              HUMAN CONFIRMS: the suggestions below only become real
                              next-steps through their + Add button (the same add_task
                              path as the manual form). The real thread stays one click
                              away — the notes hover and the client card. */}
                          {(() => {
                            const a = ai[m.pid];
                            const generating = aiBusy === m.pid;
                            const err = aiErr[m.pid];
                            // Case-start anchor (first note ever, or cohort join if
                            // earlier) — deterministic, shown even before generation.
                            const first = detail.firstNote?.[m.pid]?.slice(0, 10) ?? null;
                            const joined = m.added_at?.slice(0, 10) ?? null;
                            const start = first && joined ? (first < joined ? first : joined) : (first ?? joined);
                            const startLabel = start ? (start === first ? `first note ${start}` : `added ${start}`) : null;
                            const days = start ? Math.max(0, Math.floor((Date.now() - +new Date(`${start}T00:00:00`)) / DAY_MS)) : null;
                            return (
                              <div style={{ margin: '0 0 12px', padding: '9px 12px 10px', borderRadius: 8,
                                border: '1px solid rgba(126,103,254,0.35)', background: 'rgba(126,103,254,0.05)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <b style={{ fontSize: '.76rem', color: 'var(--primary)', letterSpacing: '.03em' }}>✦ AI CASE SUMMARY</b>
                                  {startLabel && (
                                    <span className="bnl-sub" style={{ fontSize: '.72rem' }}>
                                      <b style={{ color: 'var(--strong)' }}>since {startLabel}</b>{days != null ? ` · ${fmtInt(days)}d` : ''}
                                    </span>
                                  )}
                                  <span className="bnl-sub" style={{ fontSize: '.72rem' }}>
                                    AI-generated — verify against the notes · de-identified before sending
                                  </span>
                                  {a?.summary && (
                                    <span className="bnl-sub" style={{ fontSize: '.72rem' }}>
                                      {a.created_at?.slice(0, 10)}{a.current ? '' : ' · thread has changed since'}
                                    </span>
                                  )}
                                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                    {isAdmin && (
                                      <button className="tbtn" style={{ fontSize: '.72rem' }}
                                        title="Audit view: the exact de-identified payload that leaves the server for the Claude API — no API call is made"
                                        onClick={() => void aiPreview(m.pid)}>
                                        {aiPeek?.pid === m.pid ? 'hide sent data' : 'view sent data'}
                                      </button>
                                    )}
                                    <button className="btn" style={{ padding: '1px 9px', fontSize: 12 }}
                                      disabled={generating || busy}
                                      title="Send the de-identified thread to Claude (~1-2¢); the result is cached until the thread changes"
                                      onClick={() => void aiFetch(m.pid, true)}>
                                      {generating ? 'Generating…'
                                        : a?.summary ? (a.current ? '↻ Regenerate' : '↻ Update — thread changed') : '✦ Generate'}
                                    </button>
                                  </span>
                                </div>
                                {err ? <div className="bnl-dq" style={{ marginTop: 6 }}>{err}</div> : null}
                                {a?.cacheOk === false && (
                                  <div className="bnl-sub" style={{ marginTop: 4, fontSize: '.72rem' }}>
                                    ⚠ cache table missing — run <code>supabase/ai_summaries.sql</code> so summaries persist between visits
                                  </div>
                                )}
                                {a?.summary && (
                                  <div style={{ marginTop: 6, fontSize: '.84rem', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                                    {a.summary}
                                  </div>
                                )}
                                {(a?.proposals?.length ?? 0) > 0 && (
                                  <div style={{ marginTop: 8 }}>
                                    <div className="bnl-sub" style={{ fontSize: '.72rem', marginBottom: 4 }}>
                                      Suggested next steps — nothing is added until you click
                                    </div>
                                    {a!.proposals.map((p, i) => {
                                      const k = `${m.pid}|${i}`;
                                      const already = aiAdded[k]
                                        || mTasks.some((t) => t.body.trim().toLowerCase() === p.body.trim().toLowerCase());
                                      return (
                                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                                          <button className="btn" disabled={busy || already}
                                            style={{ padding: '0 9px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}
                                            title={`${p.rationale}${p.source_date ? ` (from note ${p.source_date})` : ''}`}
                                            onClick={async () => {
                                              const r = await act({ action: 'add_task', id: sel, pid: m.pid, body: p.body, assignee_ids: [] });
                                              if (r?.ok) { setAiAdded((s) => ({ ...s, [k]: true })); void refreshLite(); }
                                            }}>
                                            {already ? '✓ Added' : '+ Add'}
                                          </button>
                                          <span style={{ fontSize: '.82rem' }}>{p.body}</span>
                                          {p.source_date && <span className="bnl-sub" style={{ flexShrink: 0 }}>note {p.source_date}</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {a && !a.summary && !err && !generating && (
                                  <div className="bnl-sub" style={{ marginTop: 4, fontSize: '.78rem' }}>
                                    No summary yet — Generate reads the whole thread and writes what has been
                                    accomplished since the case started, and where it stands now.
                                  </div>
                                )}
                                {aiPeek?.pid === m.pid && (
                                  <pre style={{ marginTop: 8, maxHeight: 260, overflow: 'auto', fontSize: '.7rem',
                                    background: 'var(--card)', border: '1px solid var(--faint)', borderRadius: 6,
                                    padding: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{aiPeek.json}</pre>
                                )}
                              </div>
                            );
                          })()}
                          {mTasks.length === 0 && <div className="bnl-sub" style={{ marginBottom: 8 }}>No next steps yet.</div>}
                          {[...mTasks].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1))
                            .map((t) => {
                              const done = t.status === 'done';
                              return (
                            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                              {/* Status button (user request: no checkbox, no strikethrough —
                                  a green ✓ button; done text green, pending text amber) */}
                              <button className="btn" disabled={busy}
                                style={{ padding: '0 9px', fontSize: 11, fontWeight: 700, flexShrink: 0,
                                  ...(done
                                    ? { color: 'var(--accent)', borderColor: 'var(--accent)', background: 'rgba(52,199,123,0.14)' }
                                    : { color: 'var(--accent)', borderColor: 'var(--accent)' }) }}
                                title={done
                                  ? `Completed ${t.done_at?.slice(0, 10) ?? ''} by ${t.done_by ?? '—'} — click to reopen`
                                  : 'Mark completed'}
                                onClick={async () => {
                                  const r = await act({ action: 'toggle_task', task_id: t.id, done: !done });
                                  if (r?.ok) void refreshLite();
                                }}>
                                {done ? '✓ Completed' : 'Complete'}
                              </button>
                              <span style={{ fontSize: '.85rem', color: done ? 'var(--accent)' : 'var(--warn)' }}>
                                {t.body}
                              </span>
                              <span className="bnl-sub" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6,
                                  cursor: isAdmin ? 'pointer' : 'default' }}
                                title={((t.assignees?.length ?? 0)
                                  ? t.assignees.map((a) => a.name).filter(Boolean).join(', ')
                                  : 'Unassigned') + (isAdmin ? ' — click to change who is assigned' : '')}
                                onClick={isAdmin ? (e) => {
                                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                  setPeoplePick({ x: rect.left, y: rect.bottom + 6, mode: 'task', taskId: t.id });
                                } : undefined}>
                                {(t.assignees?.length ?? 0)
                                  ? <>
                                      <span style={{ display: 'inline-flex' }}>
                                        {t.assignees.slice(0, 4).map((a, i) => (
                                          <span key={a.id} style={{ marginLeft: i ? -7 : 0, display: 'inline-flex',
                                            borderRadius: '50%', border: '1.5px solid var(--card)' }}>
                                            <Avatar name={a.name} id={a.id} size={20} />
                                          </span>
                                        ))}
                                      </span>
                                      <b style={{ color: 'var(--strong)', fontWeight: 600 }}>
                                        {t.assignees.map((a) => (a.name ?? '?').split(' ')[0]).join(', ')}
                                      </b>
                                    </>
                                  : <><AvatarEmpty size={20} /> unassigned</>}
                                {' '}· {t.created_at.slice(0, 10)}
                              </span>
                              {isAdmin && (
                                <span role="button" className="bnl-sub" style={{ cursor: 'pointer', flexShrink: 0 }}
                                  title="Delete this item"
                                  onClick={async () => {
                                    const r = await act({ action: 'delete_task', task_id: t.id });
                                    if (r?.ok) void refreshLite();
                                  }}>✕</span>
                              )}
                            </div>
                              );
                            })}
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                            <input className="finput" style={{ flex: 1, minWidth: 240 }}
                              placeholder="New next step…" value={taskText}
                              onChange={(e) => setTaskText(e.target.value)} />
                            {(() => {
                              const chosen = detail.staff.filter((s) => taskAssignees.includes(s.id));
                              return (
                                <button className="btn"
                                  title={chosen.length
                                    ? `${chosen.map((s) => s.display_name || s.email).join(', ')} — click to change`
                                    : 'Assign to one or more people…'}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '3px 10px' }}
                                  onClick={(e) => {
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    setPeoplePick(peoplePick?.mode === 'draft' ? null : { x: rect.left, y: rect.bottom + 6, mode: 'draft' });
                                  }}>
                                  {chosen.length
                                    ? <>
                                        <span style={{ display: 'inline-flex' }}>
                                          {chosen.slice(0, 3).map((s, i) => (
                                            <span key={s.id} style={{ marginLeft: i ? -7 : 0, display: 'inline-flex',
                                              borderRadius: '50%', border: '1.5px solid var(--card)' }}>
                                              <Avatar name={s.display_name || s.email} id={s.id} size={22} />
                                            </span>
                                          ))}
                                        </span>
                                        {chosen.length === 1 ? (chosen[0].display_name || chosen[0].email) : `${chosen.length} people`}
                                      </>
                                    : <><AvatarEmpty size={22} /><span className="bnl-sub">Assign</span></>}
                                </button>
                              );
                            })()}
                            <button className="btn" disabled={busy || !taskText.trim()} onClick={async () => {
                              const r = await act({ action: 'add_task', id: sel, pid: m.pid, body: taskText, assignee_ids: taskAssignees });
                              if (r?.ok) { setTaskText(''); setTaskAssignees([]); void refreshLite(); }
                            }}>+ Add</button>
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                    );
                  })}
                  {detail.members.length === 0 && (
                    <tr><td colSpan={10} className="empty">{isAdmin ? 'No members yet — paste IDs above.' : 'No members visible.'}</td></tr>
                  )}
                  {detail.members.length > 0 && fStage
                    && detail.members.every((m) => m.ms_stage !== fStage) && (
                    <tr><td colSpan={10} className="empty">No members are waiting at {MS_LABELS[fStage] ?? fStage} right now.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {sel != null && !detail && !msg && <div className="panel" style={{ marginTop: 16 }}><div className="hc-none">Loading…</div></div>}

      {/* Notes hover card — fixed so the table's scroll area can't clip it
          (same pattern as the BNL roster's). */}
      {notePop && (
        <div className="panel" style={{
          position: 'fixed',
          right: Math.max(window.innerWidth - notePop.x + 10, 12),
          top: Math.min(notePop.y, Math.max(window.innerHeight - 320, 12)),
          width: 380, maxWidth: '60vw', maxHeight: 420, overflow: 'hidden',
          zIndex: 60, pointerEvents: 'none',
          padding: '12px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        }}>
          <div style={{ fontWeight: 700, fontSize: '.85rem', marginBottom: 6 }}>
            {notePop.name} <span className="bnl-sub">· last {notePop.notes.length} note{notePop.notes.length === 1 ? '' : 's'}</span>
          </div>
          {notePop.notes.map((n, i) => (
            <div key={i} style={{ marginBottom: i < notePop.notes.length - 1 ? 10 : 0 }}>
              <div className="bnl-sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {n.at}{n.author ? ` · ${n.author}` : ''}
              </div>
              <div style={{ fontSize: '.82rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {n.body}
              </div>
            </div>
          ))}
          <div className="bnl-sub" style={{ marginTop: 8 }}>open the client for the full thread</div>
        </div>
      )}

      {/* People picker — monday-style assignee menu (fixed popover + backdrop) */}
      {peoplePick && detail && (
        <>
          {/* Backdrop closes the MENU only — marked as task UI so the panel's
              click-away never fires through it (a click here used to collapse
              the whole panel and lose the draft). */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 69 }} data-tasks-ui=""
            onMouseDown={() => setPeoplePick(null)} />
          <div className="panel" onMouseMove={touchTasks} data-tasks-ui="" style={{
            position: 'fixed',
            left: Math.min(peoplePick.x, Math.max((typeof window !== 'undefined' ? window.innerWidth : 1200) - 264, 12)),
            top: Math.min(peoplePick.y, Math.max((typeof window !== 'undefined' ? window.innerHeight : 800) - 330, 12)),
            width: 252, maxHeight: 320, overflowY: 'auto', zIndex: 70,
            padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}>
            {(() => {
              const isAccess = peoplePick.mode === 'access';
              const roster = isAccess
                // Admins already see every cohort — a grant would be a no-op.
                ? detail.staff.filter((s) => !s.is_admin)
                : (isAdmin ? detail.staff : detail.staff.filter((s) => s.id === viewerId));
              const selected: string[] = isAccess
                ? (detail.access ?? []).map((a) => a.user_id)
                : peoplePick.mode === 'task'
                  ? (detail.tasks?.find((t) => t.id === peoplePick.taskId)?.assignees ?? []).map((a) => a.id)
                  : taskAssignees;
              // draft mode edits local state; task mode saves immediately;
              // access mode grants/revokes immediately. The menu STAYS OPEN so
              // several people can be toggled in a row (user request).
              const apply = async (next: string[], toggledId: string, nowOn: boolean) => {
                if (peoplePick.mode === 'draft') { setTaskAssignees(next); return; }
                if (peoplePick.mode === 'task') {
                  const r = await act({ action: 'set_assignees', task_id: peoplePick.taskId, assignee_ids: next });
                  if (r?.ok) void refreshLite();
                  return;
                }
                const r = await act({ action: nowOn ? 'grant_access' : 'revoke_access', id: sel, user_id: toggledId });
                if (r?.ok) void refreshLite();
              };
              return (
                <>
                  <div className="bnl-sub" style={{ padding: '2px 8px 6px' }}>
                    <b>{isAccess ? 'Share cohort with…' : 'Assign…'}</b> · click to toggle, several allowed
                  </div>
                  {!isAccess && (
                    <div className="dd-opt" style={{ border: 'none' }}
                      onClick={() => { void apply([], '', false); }}>
                      <AvatarEmpty size={26} /><span className="dd-nm">Clear — unassigned</span>
                    </div>
                  )}
                  {roster.map((s) => {
                    const on = selected.includes(s.id);
                    return (
                      <div key={s.id} className={`dd-opt${on ? ' on' : ''}`} style={{ border: 'none' }}
                        onClick={() => {
                          const next = on ? selected.filter((x) => x !== s.id) : [...selected, s.id];
                          void apply(next, s.id, !on);
                        }}>
                        <Avatar name={s.display_name || s.email} id={s.id} size={26} />
                        <span className="dd-nm">
                          {s.display_name || s.email}{isAccess && !s.bnl_access ? ' (no BNL access)' : ''}
                        </span>
                        {on && <span style={{ color: 'var(--primary)', fontWeight: 700, flexShrink: 0 }}>✓</span>}
                      </div>
                    );
                  })}
                  {isAccess && !roster.length && (
                    <div className="bnl-sub" style={{ padding: 8 }}>No non-admin accounts to share with.</div>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}

      {/* The SAME client card as the BNL; admin-only controls inside the
          drawer follow the real role now that cohorts can be shared. */}
      {drill && (
        <ClientDrawer row={drill} asOf={drillAsOf} isAdmin={isAdmin}
                      onClose={() => setDrill(null)} />
      )}
    </>
  );
}
