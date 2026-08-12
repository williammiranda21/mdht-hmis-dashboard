'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  POP_DEFS, MILESTONES,
  type BnlAgg, type BnlClient, type CeMilestonesAgg, type PopKey,
} from './types';
import JourneyBar from '../../../components/JourneyBar';
import ClientDrawer, { Flags } from './ClientDrawer';

type SortKey = 'name' | 'age' | 'status' | 'project' | 'days_homeless' | 'sys_days3' | 'risk_pts' | 'ref_status' | 'assessed' | 'ms_wait' | 'hh_n';

const COLS: Array<[SortKey | 'flags' | 'notes', string]> = [
  ['name', 'Client'],
  ['age', 'Age'],
  ['hh_n', 'HH'],
  ['status', 'Status'],
  ['flags', 'Flags'],
  ['project', 'Project'],
  ['days_homeless', 'Self-reported days'],
  ['sys_days3', 'In HMIS (3y)'],
  ['ms_wait', 'CE leg wait'],
  ['risk_pts', 'Risk'],
  ['ref_status', 'Referral'],
  ['assessed', 'CE assessed'],
  ['notes', 'Last note'],
];

/** '2026-08-05' → 'today' / '3d' / '2mo' — freshness for the notes column. */
function noteAge(at: string): string {
  const d = Math.max(0, Math.floor((Date.now() - +new Date(`${at}T00:00:00`)) / 86400000));
  return d === 0 ? 'today' : d < 30 ? `${d}d` : d < 365 ? `${Math.round(d / 30)}mo` : `${Math.round(d / 365)}y`;
}

/** milestone key → label, for the CE-leg-wait cells and the stage filter chip */
const MS_LABELS = Object.fromEntries(MILESTONES);

/** Rows per fetch. Must match PAGE_SIZE in lib/bnl-query.ts. */
const PAGE = 200;
/** Search is a server round-trip now, so wait for a pause in typing. */
const SEARCH_DEBOUNCE_MS = 250;

// Flags moved to ClientDrawer.tsx (shared with the cohort dashboard).

// Inflow/Outflow chart removed 2026-07-31 (user: duplicated elsewhere — the
// flow data still lives in agg.pops[pop].flow if it's ever wanted back).

export default function BnlView({
  initialRows, initialTotal, agg, ceMilestones = null, isAdmin = false, projectOpts = [],
}: { initialRows: BnlClient[]; initialTotal: number; agg: BnlAgg; ceMilestones?: CeMilestonesAgg | null; isAdmin?: boolean;
     projectOpts?: { id: number; name: string; type: string | null }[] }) {
  const [pop, setPop] = useState<PopKey>('all');
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fFlag, setFFlag] = useState('');
  const [fAsmt, setFAsmt] = useState('');
  const [fRef, setFRef] = useState('');
  // Milestone worklist — set by clicking a waiting number on the journey bar.
  const [fStage, setFStage] = useState('');
  // Multi-project filter (1..n projects; empty = all). The picker is a FIXED
  // popover anchored to its button — the panel it sits in clips overflow, and
  // the old in-flow version shoved the whole table down (user disliked it).
  const [selProjects, setSelProjects] = useState<number[]>([]);
  const [projAnchor, setProjAnchor] = useState<{ x: number; y: number } | null>(null);
  const [projQ, setProjQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('days_homeless');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [rows, setRows] = useState<BnlClient[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [drill, setDrill] = useState<BnlClient | null>(null);
  // Hover card for the notes column — a fixed-position panel (so the table's
  // scroll container can't clip it), opening to the LEFT of the cell since
  // the column is rightmost. pointer-events: none = it never steals the
  // mouse; the full thread lives in the drawer.
  const [notePop, setNotePop] = useState<{
    x: number; y: number; name: string;
    notes: NonNullable<BnlClient['notes2']>;
  } | null>(null);

  // Debounced copy of the search box — only this triggers a fetch.
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const pa = agg.pops[pop];

  const params = useCallback((offset: number) => new URLSearchParams({
    pop, status: fStatus, flag: fFlag, asmt: fAsmt, stage: fStage, ref: fRef,
    projects: selProjects.join(','), q: qDebounced,
    sort: sortKey, dir: sortDir, offset: String(offset), limit: String(PAGE),
  }), [pop, fStatus, fFlag, fAsmt, fStage, fRef, selProjects, qDebounced, sortKey, sortDir]);

  // Which request is current. A slow response for an old filter must not
  // overwrite a newer one — without this, typing fast can leave stale rows.
  const reqId = useRef(0);
  const firstRender = useRef(true);

  useEffect(() => {
    // Skip the very first run: the server already delivered page 1.
    if (firstRender.current) { firstRender.current = false; return; }
    const id = ++reqId.current;
    setLoading(true);
    setLoadErr(null);
    fetch(`/api/bnl/roster?${params(0)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { rows: BnlClient[]; total: number }) => {
        if (id !== reqId.current) return;      // superseded
        setRows(j.rows);
        setTotal(j.total);
      })
      .catch(() => { if (id === reqId.current) setLoadErr('Could not load the roster.'); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [params]);

  async function loadMore() {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/bnl/roster?${params(rows.length)}`);
      if (!res.ok) throw new Error();
      const j = (await res.json()) as { rows: BnlClient[]; total: number };
      if (id !== reqId.current) return;
      setRows((prev) => [...prev, ...j.rows]);
      setTotal(j.total);
    } catch {
      if (id === reqId.current) setLoadErr('Could not load more rows.');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  function openDrill(r: BnlClient) {
    setDrill(r);   // detail/timeline/hist3 load inside ClientDrawer
  }

  // Focus toggle — optimistic; reverts if the POST fails. Updates the open
  // drawer's copy too so the ★ stays in sync everywhere.
  async function toggleFocus(r: BnlClient) {
    const next = !r.focused;
    const apply = (v: boolean) => {
      setRows((prev) => prev.map((x) => (x.pid === r.pid ? { ...x, focused: v } : x)));
      setDrill((d) => (d && d.pid === r.pid ? { ...d, focused: v } : d));
    };
    apply(next);
    try {
      const res = await fetch('/api/bnl/focus', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: r.pid, on: next }),
      });
      if (!res.ok) apply(!next);
    } catch {
      apply(!next);
    }
  }

  function setSort(k: SortKey | 'flags' | 'notes') {
    if (k === 'flags' || k === 'notes') return;
    setSortDir(sortKey === k ? (sortDir === 'desc' ? 'asc' : 'desc') : k === 'name' ? 'asc' : 'desc');
    setSortKey(k);
  }

  const kpis: Array<[string, number | string, string, string]> = useMemo(() => {
    const c = pa.counts;
    // On the Family tab every row IS a family household, so the generic
    // "N veterans · N in families" note degenerates into the count repeating
    // itself ("721 · 721 in families") — speak household language instead.
    const activeNote = pop === 'family'
      ? 'households — one row per family'
      : `${c.vet.toLocaleString()} veterans · ${c.fam.toLocaleString()} in families`;
    return [
      ['Actively homeless', c.active, activeNote, 'var(--danger)'],
      ['Newly identified (30d)', c.new30, pop === 'family' ? 'households first seen' : 'first HMIS contact', 'var(--warn)'],
      ['Housed', c.housed, pop === 'family' ? 'households moved in / exited to PH' : 'moved in / exited to PH', 'var(--accent)'],
      ['Inactive (90d+)', c.inactive, 'no recent contact', 'var(--faint)'],
      ['Chronically homeless', c.chronic, 'HUD definition (approx.)', '#7E22CE'],
      ['CE assessed', c.active ? `${Math.round((100 * c.assessed) / c.active)}%` : '—', 'of actively homeless', 'var(--secondary)'],
    ];
  }, [pa, pop]);

  // Bar scale comes from the population aggregate, not the loaded page — using
  // the page max would rescale every bar each time more rows arrived.
  const maxDays = Math.max(pa.max_days, 1);
  const exportHref = `/api/bnl/export?${params(0)}`;

  return (
    <>
      <div className="bnl-banner bnl-wide">
        🔒 Confidential — contains client names. Data as of <b>{agg.as_of}</b>.
        <a className="btn" href={exportHref} style={{ marginLeft: 'auto' }}>⬇ CSV</a>
      </div>

      <div className="panel" style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="flabel">Population</span>
        <div className="seg">
          {(Object.keys(POP_DEFS) as PopKey[]).map((k) => (
            <button key={k} className={pop === k ? 'on' : ''} onClick={() => setPop(k)}>
              {POP_DEFS[k].label}
            </button>
          ))}
        </div>
        <span className="bnl-sub">
          {pop === 'family'
            ? <>{pa.n.toLocaleString()} households in this population{pa.people != null && <> · {pa.people.toLocaleString()} people</>}</>
            : <>{pa.n.toLocaleString()} clients in this population</>}
        </span>
      </div>

      {/* CE journey — follows the population selector (per-pop stats are
          precomputed in bnl_core; the same POPS predicates drive the roster
          query, so a clicked waiting number matches the filtered table under
          every population). Falls back to the system view until a meta
          payload carrying `pops` is loaded. */}
      {ceMilestones && (() => {
        const labels = Object.fromEntries(MILESTONES);
        const ord = ceMilestones.order;
        const ms = ceMilestones.pops?.[pop] ?? ceMilestones;
        const total = ms.housed[`${ord[0]}_${ord[ord.length - 1]}`];
        return (
          <div className="panel" style={{ marginTop: 16, padding: '12px 18px' }}>
            <div className="hc-sub" style={{ margin: '0 0 10px' }}>
              CE journey — median days between milestones
              <span className="bnl-sub" style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                {pop === 'family' ? 'households' : 'clients'} housed in the last {ceMilestones.window_months} months
                {' '}· {ceMilestones.pops?.[pop] ? POP_DEFS[pop].label : 'all populations'}
              </span>
            </div>
            {/* The bar itself is shared with the cohort dashboard — see
                components/JourneyBar.tsx. Semantics (proportional widths,
                worst-leg warn, live-wait line) live there. Clicking a waiting
                number filters the roster below to that leg's worklist. */}
            <JourneyBar order={ord} labels={labels}
                        housed={ms.housed} waiting={ms.waiting}
                        onLegClick={(k) => {
                          setFStage(k);
                          setSortKey('ms_wait');
                          setSortDir('desc');
                        }} />
            {total?.median != null && (
              <div className="bnl-sub" style={{ marginTop: 6 }}>
                End to end {labels[ord[0]] ?? ord[0]} → {labels[ord[ord.length - 1]] ?? ord[ord.length - 1]}:{' '}
                <b style={{ color: 'var(--strong)' }}>{total.median}d</b> median
                {total.mean != null && <> · avg {Math.round(total.mean)}d</>} (n={total.n})
                {' '}· above each segment: completed journeys · below: clients on that leg right now, days so far
                {' '}· bold = median (typical client), avg = mean (pulled up by long-tail outliers)
              </div>
            )}
            {/* Journey trend — sparkline per leg by MOVE-IN fiscal quarter
                (user-approved mockup 2026-08-11). All populations regardless
                of the selector; lower is faster; green ▼ = latest quarter
                faster than the prior one. Quarters with no completed pairs
                are gaps, not zeros. */}
            {(ceMilestones.trend?.length ?? 0) >= 2 && (() => {
              const tr = ceMilestones.trend!;
              const legPairs = ord.slice(0, -1).map((a, i) =>
                [`${a}_${ord[i + 1]}`, `${labels[a] ?? a} → ${labels[ord[i + 1]] ?? ord[i + 1]}`] as const);
              const e2eKey = `${ord[0]}_${ord[ord.length - 1]}`;
              const cards = [...legPairs, [e2eKey, 'End to end'] as const];
              return (
                <div style={{ marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.15)', paddingTop: 10 }}>
                  <div className="bnl-sub" style={{ marginBottom: 8 }}>
                    Trend by move-in quarter · {tr[0].q} → {tr[tr.length - 1].q} · all populations · lower is faster
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {cards.map(([k, lbl]) => {
                      const isE2E = k === e2eKey;
                      const pts = tr
                        .map((t) => ({ q: t.q, n: t.legs[k]?.n ?? 0, median: t.legs[k]?.median ?? null }))
                        .filter((p): p is { q: string; n: number; median: number } => p.median != null);
                      const base = {
                        flex: isE2E ? 1.2 : 1, minWidth: isE2E ? 132 : 118,
                        border: `1px solid ${isE2E ? 'var(--primary)' : 'rgba(148,163,184,0.2)'}`,
                        borderRadius: 8, padding: '8px 10px',
                      } as const;
                      if (pts.length < 2) {
                        return (
                          <div key={k} style={base}>
                            <div style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lbl}</div>
                            <div className="bnl-sub" style={{ marginTop: 6 }}>not enough quarters</div>
                          </div>
                        );
                      }
                      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
                      const d = last.median - prev.median;
                      const col = d < 0 ? 'var(--accent)' : d > 0 ? 'var(--warn)' : 'var(--muted)';
                      const W = 110, H = 26, P = 3;
                      const meds = pts.map((p) => p.median);
                      const mn = Math.min(...meds), mx = Math.max(...meds);
                      const x = (i: number) => P + (i * (W - 2 * P)) / (pts.length - 1);
                      const y = (m: number) => (mx === mn ? H - 6 : (H - P) - ((m - mn) / (mx - mn)) * (H - 2 * P));
                      const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.median).toFixed(1)}`).join(' ');
                      return (
                        <div key={k} style={base}
                          title={pts.map((p) => `${p.q}: median ${Math.round(p.median)}d (n=${p.n})`).join('\n')}>
                          <div style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lbl}</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '2px 0 4px' }}>
                            <span style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.round(last.median)}d</span>
                            <span style={{ fontSize: 10.5, color: col, whiteSpace: 'nowrap' }}>
                              {d < 0 ? `▼ ${Math.abs(Math.round(d))}d faster` : d > 0 ? `▲ ${Math.round(d)}d slower` : '— flat'}
                            </span>
                          </div>
                          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }} aria-hidden="true">
                            <polyline points={line} fill="none" stroke={col} strokeWidth={1.8}
                              strokeLinejoin="round" strokeLinecap="round" />
                            <circle cx={x(pts.length - 1)} cy={y(last.median)} r={2.4} fill={col} />
                          </svg>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

      <div className="bnl-kpis" style={{ marginTop: 16 }}>
        {kpis.map(([label, val, note, color]) => (
          <div key={label} className="bnl-kpi" style={{ ['--kc' as any]: color }}>
            <div className="bnl-kpi-lbl">{label}</div>
            <div className="bnl-kpi-val num">{typeof val === 'number' ? val.toLocaleString() : val}</div>
            <div className="bnl-kpi-note">{note}</div>
          </div>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="fbar" style={{ marginBottom: 8 }}>
          <div className="frow">
            <div className="fgroup">
              <span className="flabel">Search</span>
              <input className="finput" placeholder="Name or project…" value={q}
                onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="fgroup">
              <span className="flabel">Status</span>
              <select className="fselect" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">All</option>
                <option value="active">Actively homeless</option>
                <option value="housed">Housed</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="fgroup">
              <span className="flabel">Flag</span>
              <select className="fselect" value={fFlag} onChange={(e) => setFFlag(e.target.value)}>
                <option value="">Any</option>
                <option value="is_new">Newly identified</option>
                <option value="returned">Returned</option>
                <option value="chronic">Chronic</option>
                <option value="veteran">Veteran</option>
                <option value="family">In a family</option>
                <option value="parenting">Parenting</option>
                <option value="unaccompanied">Unaccompanied</option>
                <option value="in_school">In school</option>
                <option value="dq">Has DQ issue</option>
                <option value="focus">★ Focused</option>
              </select>
            </div>
            <div className="fgroup">
              <span className="flabel">Referral</span>
              <select className="fselect" value={fRef} onChange={(e) => setFRef(e.target.value)}>
                <option value="">Any</option>
                <option value="psh">PSH</option>
                <option value="rrh">RRH</option>
                <option value="none">No referral</option>
              </select>
            </div>
            <div className="fgroup">
              <span className="flabel">Projects</span>
              <button className="btn" title="Filter the roster to one or more projects"
                style={selProjects.length ? { color: 'var(--primary)', fontWeight: 700 } : undefined}
                onClick={(e) => {
                  if (projAnchor) { setProjAnchor(null); return; }
                  const rect = e.currentTarget.getBoundingClientRect();
                  setProjAnchor({ x: rect.left, y: rect.bottom });
                }}>
                {selProjects.length === 1
                  ? (projectOpts.find((o) => o.id === selProjects[0])?.name ?? '1 selected').slice(0, 26)
                  : selProjects.length ? `${selProjects.length} projects` : 'All'} {projAnchor ? '▴' : '▾'}
              </button>
            </div>
            <div className="fgroup">
              <span className="flabel">CE assessed</span>
              <select className="fselect" value={fAsmt} onChange={(e) => setFAsmt(e.target.value)}>
                <option value="">Any</option>
                <option value="y">Assessed</option>
                <option value="n">Not assessed</option>
              </select>
            </div>
            {fStage && (
              <div className="fgroup">
                <span className="flabel">Worklist</span>
                <button className="btn" onClick={() => setFStage('')}
                  title="Showing clients stuck on this CE leg (from the journey bar). Click to clear.">
                  ⏳ Waiting at {MS_LABELS[fStage] ?? fStage} ✕
                </button>
              </div>
            )}
          </div>
        </div>

        {/* scroll-pin: only the LIST scrolls (viewport-bounded, sticky header)
            — the filters and journey card above stay put, same as the DQ tab. */}
        <div className="scroll scroll-pin" style={loading ? { opacity: 0.55, transition: 'opacity .15s' } : undefined}>
          <table className="bnl-table">
            <thead>
              <tr>
                {COLS.map(([k, label]) => (
                  <th key={k} className={sortKey === k ? 'sorted' : ''} onClick={() => setSort(k)}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const col = r.days_homeless >= 365 ? 'var(--danger)' : r.days_homeless >= 180 ? 'var(--warn)' : 'var(--secondary)';
                return (
                  <tr key={r.pid} className="bnl-row" onClick={() => openDrill(r)}
                    style={r.focused ? { background: 'rgba(234,179,8,0.08)', boxShadow: 'inset 3px 0 0 var(--warn)' } : undefined}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span className="pp-noprint" role="button"
                          title={r.focused ? 'On the focus list — click to remove' : 'Focus this client for case conferencing'}
                          onClick={(e) => { e.stopPropagation(); toggleFocus(r); }}
                          style={{ cursor: 'pointer', fontSize: 14, lineHeight: 1,
                            color: r.focused ? 'var(--warn)' : 'var(--faint)' }}>
                          {r.focused ? '★' : '☆'}
                        </span>
                        <div className="bnl-nm bnl-drillname" style={/unsheltered/.test(r.detail ?? '') ? { color: 'var(--danger)' } : undefined}>{r.name}</div>
                      </div>
                      <div className="bnl-sub">{r.detail}</div>
                    </td>
                    <td className="num">{r.age ?? '—'}</td>
                    <td className="num">{(r.hh_n ?? 1) > 1
                      ? <span title={`${r.hh_n} people in this household — open the client for the member list`}>{r.hh_n}</span>
                      : <span className="bnl-sub">1</span>}</td>
                    <td><span className={`bnl-chip bnl-${r.status}`}>{r.status === 'active' ? 'Active' : r.status === 'housed' ? 'Housed' : 'Inactive'}</span></td>
                    <td><Flags r={r} /></td>
                    <td style={{ minWidth: 220 }}>{r.project ? <><span className="ty">{r.ptype ?? '?'}</span> {r.project}{r.enrolled ? null : <span className="bnl-sub" title="not a current enrollment — last known project"> (former)</span>}</> : <span className="bnl-sub">—</span>}</td>
                    <td>
                      <div className="bnl-dh">
                        <div className="bnl-dh-tr"><div className="bnl-dh-fl" style={{ width: `${Math.min(100, (100 * r.days_homeless) / maxDays)}%`, background: col }} /></div>
                        <span className="num">{r.days_homeless.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="num">{r.sys_days3.toLocaleString()} d <span className="bnl-sub">· {r.episodes3} ep</span></td>
                    <td className="num">{r.ms_wait != null
                      ? <>{r.ms_wait.toLocaleString()}d <span className="bnl-sub">· {MS_LABELS[r.ms_stage ?? ''] ?? r.ms_stage}</span></>
                      : <span className="bnl-sub">—</span>}</td>
                    <td>{r.risk_pts == null ? <span className="bnl-sub">—</span> : (
                      // Youth prioritization bands per spec: Low 0–7, High 8+.
                      // Two colors only — matches the ETL's risk_band exactly.
                      <span className={`bnl-rp ${r.risk_pts >= 8 ? 'bnl-rp-hi' : 'bnl-rp-lo'}`}
                        title={`${r.risk_pts >= 8 ? 'High' : 'Low'} priority — ${r.risk_pts} of ${r.risk_max} points (Low 0–7 · High 8+ · HNA items pending)`}>
                        {r.risk_pts} pts{r.risk_pts >= 8 ? ' · High' : ''}</span>
                    )}</td>
                    <td>{r.ref_type ? (
                      <><div>{r.ref_type} · <b>{r.ref_status}</b></div><div className="bnl-sub">{r.ref_date}{r.ref_prov ? ` · ${r.ref_prov}` : ''}</div></>
                    ) : <span className="bnl-sub">—</span>}</td>
                    <td className="num">{r.assessed
                      ? <>{r.assessed}{r.spdat_tool && (
                          <div className="bnl-sub">{r.spdat_tool}{r.spdat_score != null ? ` · ${r.spdat_score}` : ''}</div>
                        )}</>
                      : <span className="bnl-sub">no</span>}</td>
                    <td style={{ maxWidth: 220 }}
                      onMouseEnter={(e) => {
                        if (!r.notes2?.length) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        setNotePop({ x: rect.left, y: rect.top, name: r.name, notes: r.notes2 });
                      }}
                      onMouseLeave={() => setNotePop(null)}>
                      {(r.notes2?.length ?? 0)
                        ? (() => {
                            const latest = r.notes2![0];
                            const age = noteAge(latest.at);
                            const fresh = age === 'today' || age.endsWith('d');
                            return (
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, maxWidth: 220 }}>
                                {r.notes2!.length > 1 && (
                                  <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                                    border: '1px solid rgba(148,163,184,0.35)', borderRadius: 8, padding: '0 5px' }}>
                                    {r.notes2!.length}{r.notes2!.length === 5 ? '+' : ''}
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
                  </tr>
                );
              })}
              {!rows.length && !loading && (
                <tr><td colSpan={COLS.length}><div className="hc-none">No clients match these filters.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="bnl-cnote" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>
            {rows.length.toLocaleString()} of {total.toLocaleString()} shown ({POP_DEFS[pop].label})
            {loading && <span className="bnl-sub"> · loading…</span>}
          </span>
          {rows.length < total && (
            <button className="btn" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : `Show ${Math.min(PAGE, total - rows.length)} more`}
            </button>
          )}
          {loadErr && <span style={{ color: 'var(--danger)' }}>{loadErr}</span>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><h3>Methodology &amp; prioritization</h3></div>
        <p className="bnl-method">
          Cohort: everyone with HMIS activity in the last 24 months (ES, SH, TH, SO, PSH, RRH, PH, CE;
          Services-Only and Prevention excluded). <b>Actively homeless</b> = open ES/SH/TH/SO enrollment,
          PH match awaiting move-in, or a literal-homeless street-outreach sighting within 90 days.
          <b> Housed</b> = PH enrollment with move-in, or most recent exit to a permanent destination.
          <b> Inactive</b> = no open enrollment and no recent outreach sighting. Populations: Youth 18–24 ·
          Veterans (self-reported) · Families (household includes a child) · Single adults 25+ · Seniors 62+.
          <b> Default ordering is acuity-first:</b> actively homeless before inactive before housed, then
          longest time homeless first — the top of the list is always the highest-need, longest-waiting
          person in the selected population. <b>Self-reported (3.917)</b> uses the HUD 3.917 fields from
          intake: approximate episode start date (age-13 floor, 25-year cap; implausible dates get a DQ
          flag), times homeless in the past 3 years (3.917.4), and months homeless (3.917.5); PSH/RRH
          residency never counts. <b>In HMIS (3y)</b> is what the system observed in the last 3 years:
          merged ES/SH/TH/SO enrollment nights plus outreach contact days — per HUD&apos;s Defining
          &quot;Chronically Homeless&quot; Final Rule, a break of 7+ consecutive nights separates occasions.
          <b>CHRONIC</b> approximates the HMIS Reporting Glossary CH logic: disabling condition plus either
          12+ continuous months or 4+ occasions totaling 12+ months. Confirm statuses in case conferencing.
        </p>
      </div>

      {/* Project picker popover — fixed + anchored to its button (the panel
          clips overflow), transparent backdrop closes it. Single column so
          names breathe; selected first, then active projects, (INACTIVE)
          last instead of alphabetically first. */}
      {projAnchor && (() => {
        const norm = projQ.trim().toLowerCase();
        const isInactive = (n: string) => /^\s*\(\s*INACTIVE/i.test(n);
        const opts = projectOpts
          .filter((o) => !norm || o.name.toLowerCase().includes(norm))
          .sort((a, b) => {
            const sa = selProjects.includes(a.id) ? 0 : 1;
            const sb = selProjects.includes(b.id) ? 0 : 1;
            if (sa !== sb) return sa - sb;
            const ia = isInactive(a.name) ? 1 : 0, ib = isInactive(b.name) ? 1 : 0;
            if (ia !== ib) return ia - ib;
            return a.name.localeCompare(b.name);
          });
        return (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setProjAnchor(null)} />
            <div className="panel" style={{
              position: 'fixed', zIndex: 50,
              left: Math.min(projAnchor.x, Math.max(window.innerWidth - 480, 8)),
              top: projAnchor.y + 6,
              width: 460, maxWidth: '92vw',
              boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            }}>
              <div style={{ padding: '10px 12px 8px' }}>
                <input className="finput" autoFocus placeholder="Search projects…" value={projQ}
                  onChange={(e) => setProjQ(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div style={{ maxHeight: 320, overflowY: 'auto', padding: '0 6px' }}>
                {opts.map((o) => (
                  <label key={o.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                      borderRadius: 6, cursor: 'pointer',
                      background: selProjects.includes(o.id) ? 'var(--primary-soft)' : undefined }}
                    title={o.type ? `${o.name} · ${o.type}` : o.name}>
                    <input type="checkbox" checked={selProjects.includes(o.id)}
                      onChange={() => setSelProjects((s) =>
                        s.includes(o.id) ? s.filter((x) => x !== o.id) : [...s, o.id])} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', fontSize: 13,
                      color: isInactive(o.name) ? 'var(--muted)' : undefined }}>{o.name}</span>
                    {o.type && <span className="ty" style={{ marginLeft: 0, flexShrink: 0 }}>{o.type}</span>}
                  </label>
                ))}
                {!opts.length && <div className="hc-none">No projects match that search.</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                borderTop: '1px solid rgba(148,163,184,0.2)' }}>
                <span className="bnl-sub">{selProjects.length ? `${selProjects.length} selected` : 'showing all projects'}</span>
                <span style={{ flex: 1 }} />
                {selProjects.length > 0 && (
                  <button className="btn" onClick={() => setSelProjects([])}>Clear</button>
                )}
                <button className="btn" onClick={() => setProjAnchor(null)}>Done</button>
              </div>
            </div>
          </>
        );
      })()}

      {/* Notes hover card — fixed so the table's scroll area can't clip it;
          opens leftward from the rightmost column, clamped to the viewport. */}
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

      {drill && (
        <ClientDrawer row={drill} asOf={agg.as_of} isAdmin={isAdmin}
                      focused={drill.focused} onToggleFocus={() => toggleFocus(drill)}
                      onClose={() => setDrill(null)} />
      )}
    </>
  );
}
