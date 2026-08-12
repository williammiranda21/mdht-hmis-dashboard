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
}
interface Task {
  id: number; pid: string; body: string;
  /** [{id, name}] account snapshots — several assignees allowed */
  assignees: { id: string; name: string | null }[];
  status: 'open' | 'done';
  created_by: string | null; created_at: string;
  done_at: string | null; done_by: string | null;
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
  useEffect(() => { setOpenTasks(null); setTaskText(''); setTaskAssignees([]); setPeoplePick(null); }, [sel]);
  // Auto-collapse an idle Next-steps panel (user request): any activity inside
  // it resets the clock; a non-empty draft or an open people picker counts as
  // activity, so nothing in progress is ever swallowed. Refs (not state) so
  // mousemoves don't re-render.
  const TASKS_IDLE_MS = 20_000;
  const tasksTouchRef = useRef(Date.now());
  const draftRef = useRef(false);
  useEffect(() => { draftRef.current = taskText.trim().length > 0 || peoplePick !== null; }, [taskText, peoplePick]);
  const touchTasks = () => { tasksTouchRef.current = Date.now(); };
  useEffect(() => {
    if (!openTasks) return;
    tasksTouchRef.current = Date.now();
    const iv = setInterval(() => {
      if (draftRef.current) { tasksTouchRef.current = Date.now(); return; }
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

            {/* Access — which accounts can open this cohort (admin-curated).
                Grants open the cohort page + tasks; the member NAMES still ride
                on BNL access, so flag grantees who lack it. */}
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
                              if (r?.ok) loadDetail(sel!);
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
            {isAdmin && (
              <div style={{ padding: '0 18px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <textarea className="finput" rows={2} style={{ minWidth: 320, flex: 1 }}
                  placeholder="Paste hashed client IDs (one per line, or comma/space separated)…"
                  value={paste} onChange={(e) => setPaste(e.target.value)} />
                <button className="btn" disabled={busy || !paste.trim()} onClick={async () => {
                  const pids = paste.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
                  const r = await act({ action: 'add_members', id: sel, pids });
                  if (r?.ok) {
                    setPaste('');
                    setMsg(`Added ${r.added}.${(r.unknown as string[]).length ? ` Not on the roster (skipped): ${(r.unknown as string[]).join(', ')}` : ''}`);
                    loadDetail(sel!); loadList();
                  }
                }}>+ Add clients</button>
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
                      {/* Next steps — open-item count + the assigned people
                          (monday-style avatar stack), click expands the checklist */}
                      <td onClick={(e) => e.stopPropagation()} data-tasks-ui="">
                        {detail.tasks === null
                          ? <span className="bnl-sub" title="Run supabase/cohort_tasks.sql to enable">—</span>
                          : (() => {
                            const people: { id: string; name: string | null }[] = [];
                            for (const t of mTasks) {
                              if (t.status !== 'open') continue;
                              for (const a of t.assignees ?? []) {
                                if (!people.some((p) => p.id === a.id)) people.push(a);
                              }
                            }
                            return (
                              <button className="btn" style={{ padding: '2px 8px', fontSize: 12,
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                                ...(openN ? { borderColor: 'var(--warn)', color: 'var(--warn)' } : {}) }}
                                title={expanded ? 'Collapse next steps'
                                  : people.length
                                    ? `Open items assigned to ${people.map((p) => p.name).filter(Boolean).join(', ')}`
                                    : 'Show next steps for this member'}
                                onClick={() => { setOpenTasks(expanded ? null : m.pid); setTaskText(''); setTaskAssignees([]); }}>
                                {people.length > 0 && (
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
                                )}
                                {openN ? `${openN} open` : mTasks.length ? 'all done' : '+ add'} {expanded ? '▴' : '▾'}
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
                          onMouseMove={touchTasks} onClick={touchTasks} onKeyDown={touchTasks}>
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
                                  if (r?.ok) loadDetail(sel!);
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
                                    if (r?.ok) loadDetail(sel!);
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
                              if (r?.ok) { setTaskText(''); setTaskAssignees([]); loadDetail(sel!); }
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
          <div style={{ position: 'fixed', inset: 0, zIndex: 69 }} onClick={() => setPeoplePick(null)} />
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
                  if (r?.ok) loadDetail(sel!);
                  return;
                }
                const r = await act({ action: nowOn ? 'grant_access' : 'revoke_access', id: sel, user_id: toggledId });
                if (r?.ok) loadDetail(sel!);
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
