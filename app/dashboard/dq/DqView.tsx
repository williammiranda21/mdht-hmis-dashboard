'use client';

/*
 * Data Quality (APR Q6) tab — port of renderDQ() in apr_monthly_report.py.
 * Scores/percentages are precomputed per project in dq_metrics.data; this view
 * only aggregates the KPI cards and applies the score bands. Band rules (match source):
 *   score cells: >=80 green, >=60 amber, else red.
 *   "missing %" cells: 0% good, <=threshold normal, > threshold red (move-in thr 10, annual thr 20).
 *   KPI percents are client-weighted (Σ pct/100 * weight ÷ Σ weight).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity } from '../../../lib/types';
import { periodLabel, fmtInt } from '../../../lib/format';
import DqFixList from './DqFixList';

type DqRecord = Record<string, number | null>;
type Row = { project_id: number; name: string; type_name: string; project_type: number | null; d: DqRecord };

type EvaCount = { hp: number; error: number; warning: number };
/** Per-project data-quality-check counts, keyed by check category
 *  ('Household' | 'Dates' | 'Duplicates' | 'Income'). Snapshot of the latest
 *  complete month — independent of the selected period. */
type EvaCatCounts = Record<string, EvaCount>;
type Props = {
  periods: string[]; granularity: Granularity; period: string; rows: Row[];
  /** Auto-open this project's fix-list on mount (deep-link from Deep Dive). */
  focusProject?: number | null;
  evaCounts?: Record<number, EvaCatCounts>;
  /** Month the check columns describe — equals `period` on monthly views;
   *  quarterly/fiscal fall back to the latest complete month. */
  evaPeriod?: string;
  /** project_id → metrics past their Homeless Trust due date with records
   *  still on the list (computed server-side in page.tsx). */
  overdue?: Record<number, string[]>;
  /** System KPI strip aggregates (2026-09-03) — computed server-side, always
   *  system-wide (never scoped by the table's type/search filters). */
  sysKpi?: {
    scoreSeries: { period: string; score: number | null }[];
    fixTotal: number; fixProjects: number; topMetric: string | null; topCount: number;
    fixedN: number; medianFix: number | null;
    overdueItems: number; overdueProjects: number;
  };
};

/** Short element names for the KPI strip (fix-list drill metric → label). */
const METRIC_SHORT: Record<string, string> = {
  'dq:dest': 'exit destinations', 'dq:movein': 'move-in dates',
  'dq:income': 'income at entry', 'dq:incexit': 'income at exit',
  'dq:annual': 'annual assessments', 'dq:veteran': 'veteran status',
  'dq:psd': 'overlapping stays', 'dq:relhoh': 'household heads',
  'dq:coc': 'enrollment CoC', 'dq:disabling': 'disabling condition',
  'dq:chronic': 'homeless history', 'dq:openstay': 'left-open enrollments',
  'dq:name': 'names', 'dq:ssn': 'SSNs', 'dq:dob': 'DOBs',
  'dq:race': 'race/ethnicity', 'dq:sex': 'sex',
};

/** [label, pctKey, denomKey] for the dynamic weakest-element card. */
const WEAK_ELEMENTS: [string, string, string][] = [
  ['Exit destination', 'DQ_Dest_pct', 'DQ_ExitsTotal'],
  ['Income at entry (DK/refused)', 'DQ_IncDK_pct', 'DQ_ActiveTotal'],
  ['Income at entry (missing)', 'DQ_IncMiss_pct', 'DQ_ActiveTotal'],
  ['Income at entry (inconsistent)', 'DQ_IncConflict_pct', 'DQ_ActiveTotal'],
  ['Income at exit', 'DQ_IncExit_pct', 'DQ_ExitsTotal'],
  ['Annual assessment income', 'DQ_Annual_pct', 'DQ_AnnualDue'],
  ['Move-in dates', 'DQ_MoveIn_pct', 'DQ_PHEnrolls'],
  ['SSN quality', 'DQ_SSN_pct', 'DQ_Clients'],
  ['Names', 'DQ_Name_pct', 'DQ_Clients'],
  ['Date of birth', 'DQ_DOB_pct', 'DQ_Clients'],
  ['Race/ethnicity', 'DQ_Race_pct', 'DQ_Clients'],
  ['Veteran status', 'DQ_Veteran_pct', 'DQ_ActiveTotal'],
  ['Household heads', 'DQ_RelHoH_pct', 'DQ_ActiveTotal'],
  ['Overlapping stays', 'DQ_PSD_pct', 'DQ_ActiveTotal'],
  ['Enrollment CoC', 'DQ_CoC_pct', 'DQ_ActiveTotal'],
  ['Disabling condition', 'DQ_Disabling_pct', 'DQ_ActiveTotal'],
  ['Homeless history (3.917)', 'DQ_Chronic_pct', 'DQ_ChronicUniverse'],
];

/** Compact severity chips (high-priority / error / warning) for one category. */
function ChecksCell({ c, bare }: { c?: EvaCount; bare?: boolean }) {
  if (!c || (c.hp === 0 && c.error === 0 && c.warning === 0)) {
    return bare ? null : <span style={{ color: 'var(--muted)' }}>—</span>;
  }
  const chip = (n: number, color: string, title: string) => n > 0 && (
    <span key={title} title={`${n} client${n === 1 ? '' : 's'} · ${title}`} style={{
      color, border: `1px solid ${color}`, borderRadius: 999, padding: '0 7px',
      fontSize: 11, fontWeight: 700, marginRight: 4, whiteSpace: 'nowrap',
    }}>{n}</span>
  );
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {chip(c.hp, 'var(--danger)', 'high priority')}
      {chip(c.error, 'var(--warn)', 'error')}
      {chip(c.warning, 'var(--muted)', 'warning')}
    </span>
  );
}

/** Toggleable columns (Project / Type / Overall are always shown). */
const TOGGLE_COLS: { k: string; label: string }[] = [
  { k: 'pii', label: 'Q6a PII' },
  { k: 'univ', label: 'Q6b Universal' },
  { k: 'inc', label: 'Q6c Income' },
  { k: 'chronic', label: 'Q6d Chronic' },
  { k: 'movein', label: 'Move-In Missing' },
  { k: 'annual', label: 'Annual Income' },
  { k: 'integrity', label: 'Record Integrity' },
  { k: 'fixtime', label: 'Fix timeliness' },
  { k: 'household', label: 'Household checks' },
  { k: 'dates', label: 'Date checks' },
  { k: 'dupes', label: 'Duplicates' },
  { k: 'active', label: 'Active' },
  { k: 'exits', label: 'Exits' },
];
// v2 (2026-08-14): key bump reveals the new Record Integrity column to
// browsers that had already persisted a v1 column selection.
const COLS_LS_KEY = 'dq_visible_cols_v2';

const scoreClass = (v: number | null) => (v == null ? '' : v >= 80 ? 'dq-green' : v >= 60 ? 'dq-amber' : 'dq-red');
const scoreColor = (v: number) => (v >= 80 ? 'var(--accent)' : v >= 60 ? 'var(--warn)' : 'var(--danger)');

function ScorePill({ v }: { v: number | null }) {
  if (v == null) return <span style={{ color: 'var(--muted)' }}>N/A</span>;
  return <span className={`dq-score-pill ${scoreClass(v)}`}>{v}%</span>;
}

function Gauge({ score }: { score: number | null }) {
  if (score == null) return <>—</>;
  return (
    <span className="dq-gauge-wrap">
      <span className="dq-gauge-bar"><span className="dq-gauge-fill" style={{ width: `${score}%`, background: scoreColor(score) }} /></span>
      <span className={`dq-score-pill ${scoreClass(score)}`}>{score}%</span>
    </span>
  );
}

function PctCell({ pct, thr, sub }: { pct: number | null; thr: number; sub?: string | null }) {
  if (pct == null) return <td className="num" style={{ color: 'var(--muted)' }}>N/A</td>;
  const cls = pct === 0 ? 'cell-good-flag' : pct <= thr ? '' : 'cell-ph-flag';
  return (
    <td className={`num ${cls}`}>{pct}%{sub && <div className="dqsub">{sub}</div>}</td>
  );
}

type SortKey = 'name' | 'type_name' | string;

export default function DqView({ periods, granularity, period, rows, evaCounts, evaPeriod, focusProject = null, overdue = {}, sysKpi }: Props) {
  // Check-column tooltips carry the fallback month on non-monthly views.
  const evaWhen = granularity === 'monthly' ? '' : ` · shown for ${evaPeriod ?? 'the latest complete month'} (checks are monthly)`;
  const router = useRouter();
  // Column visibility — default all on; persisted per browser.
  const [visible, setVisible] = useState<Set<string>>(() => new Set(TOGGLE_COLS.map((c) => c.k)));
  const [colsOpen, setColsOpen] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(COLS_LS_KEY);
      if (saved) setVisible(new Set(JSON.parse(saved) as string[]));
    } catch { /* first visit / bad JSON — keep defaults */ }
  }, []);
  const vis = (k: string) => visible.has(k);
  const toggleCol = (k: string) => setVisible((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    try { localStorage.setItem(COLS_LS_KEY, JSON.stringify([...n])); } catch { /* private mode */ }
    return n;
  });
  const [typeFilter, setTypeFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('DQ_Score');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  // Fix-list drills exist for EVERY DQ granularity since 2026-09-03 — a
  // quarterly/fiscal list is the union of its months (review view); the
  // monthly list stays the working cadence (due dates + days-open ledger).
  const canFix = true;
  const [fixRow, setFixRow] = useState<Row | null>(null);

  // Deep-link support: land with a project's fix-list already open.
  useEffect(() => {
    if (focusProject == null) return;
    const r = rows.find((x) => x.project_id === focusProject);
    if (r) setFixRow(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProject]);

  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.type_name && s.add(r.type_name));
    return ['All', ...Array.from(s).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) =>
      (typeFilter === 'All' || r.type_name === typeFilter) &&
      (!q || r.name.toLowerCase().includes(q)),
    );
  }, [rows, typeFilter, query]);

  const sorted = useMemo(() => {
    const val = (r: Row): number | string | null =>
      sortKey === 'name' ? r.name : sortKey === 'type_name' ? r.type_name : r.d[sortKey];
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * sortDir;
      const xn = x == null ? -Infinity : x, yn = y == null ? -Infinity : y;
      return (xn - yn) * sortDir;
    });
  }, [filtered, sortKey, sortDir]);

  // System KPI strip (2026-09-03) — ALWAYS system-wide over `rows`, never the
  // table's filters: the strip answers "how is the SYSTEM doing", the
  // filterable table below handles subsets.
  const kpi = useMemo(() => {
    const valid = rows.map((r) => r.d.DQ_Score).filter((v): v is number => v != null);
    const avgScore = valid.length ? +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1) : null;
    // Weakest element: universe-weighted system rate per element, worst wins.
    // Min universe 50 so a 3-client denominator can't claim the headline.
    let weakest: { label: string; pct: number; denom: number } | null = null;
    for (const [label, pctKey, denomKey] of WEAK_ELEMENTS) {
      let num = 0, den = 0;
      for (const r of rows) {
        const dv = (r.d[denomKey] ?? 0) as number, pv = r.d[pctKey];
        if (dv > 0 && pv != null) { den += dv; num += (pv / 100) * dv; }
      }
      if (den >= 50) {
        const pct = +((num / den) * 100).toFixed(1);
        if (!weakest || pct > weakest.pct) weakest = { label, pct, denom: den };
      }
    }
    return { avgScore, weakest };
  }, [rows]);
  // score direction vs the prior period of the SAME granularity
  const prevScore = sysKpi?.scoreSeries?.[1]?.score ?? null;
  const scoreDelta = kpi.avgScore != null && prevScore != null
    ? +(kpi.avgScore - prevScore).toFixed(1) : null;
  const sparkPts = useMemo(() => {
    const s = [...(sysKpi?.scoreSeries ?? [])].reverse()
      .filter((p): p is { period: string; score: number } => p.score != null);
    return s;
  }, [sysKpi]);

  function navigate(patch: Partial<{ g: string; p: string }>) {
    const sp = new URLSearchParams();
    sp.set('g', patch.g ?? granularity);
    if (!('g' in patch) || patch.g === granularity) sp.set('p', patch.p ?? period);
    router.push(`/dashboard/dq?${sp.toString()}`);
  }
  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === 'name' || k === 'type_name' ? 1 : -1); }
  }
  const car = (k: SortKey) => <span className="car">{sortKey === k ? (sortDir < 0 ? '▼' : '▲') : '▼'}</span>;
  const th = (k: SortKey, num = false) => `sortable${num ? ' num' : ''}${sortKey === k ? ' sorted' : ''}`;

  return (
    <>
      <div className="fbar">
        <div className="frow">
          <div className="fgroup">
            <span className="flabel">View by</span>
            <div className="seg">
              {(['monthly', 'quarterly', 'fiscal'] as Granularity[]).map((g) => (
                <button key={g} className={granularity === g ? 'on' : ''} onClick={() => navigate({ g })}>
                  {g === 'monthly' ? 'Monthly' : g === 'quarterly' ? 'Quarterly' : 'Fiscal Year'}
                </button>
              ))}
            </div>
          </div>
          <div className="fgroup">
            <span className="flabel">Report period</span>
            <select className="fselect" value={period} onChange={(e) => navigate({ p: e.target.value })}>
              {periods.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
            </select>
          </div>
          <div className="fgroup">
            <span className="flabel">Project type</span>
            <select className="fselect" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              {typeOptions.map((t) => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
            </select>
          </div>
          <div className="fgroup">
            <span className="flabel">Search projects</span>
            <input className="finput" placeholder="Filter by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="fgroup" style={{ marginLeft: 'auto' }}>
            <span className="flabel">&nbsp;</span>
            <a className="btn" href="/dashboard/dq/users" title="Error rates and score cards per HMIS data-entry user">
              👤 Error rates by user
            </a>
          </div>
        </div>
      </div>

      {/* System strip (2026-09-03): direction · workload · momentum ·
          accountability · weakest spot. Replaces three hardcoded Q6c element
          cards; every figure is system-wide (the table below filters). */}
      <div className="dq-kpi-grid">
        <div className="dq-kpi" title="Average DQ score across all active projects — delta vs the prior period of this view's granularity">
          <div className="dq-kpi-label">System DQ Score</div>
          <div className="dq-kpi-val" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {kpi.avgScore != null ? <span className={`dq-score-pill ${scoreClass(kpi.avgScore)}`} style={{ fontSize: 20 }}>{kpi.avgScore}%</span> : '—'}
            {scoreDelta != null && (
              <span style={{ fontSize: 12, fontWeight: 700, color: scoreDelta >= 0 ? 'var(--accent)' : 'var(--danger)' }}>
                {scoreDelta >= 0 ? '▲' : '▼'} {Math.abs(scoreDelta)}
              </span>
            )}
            {sparkPts.length >= 2 && (() => {
              const W = 84, H = 22, P = 2;
              const vals = sparkPts.map((p) => p.score);
              const mn = Math.min(...vals), mx = Math.max(...vals);
              const x = (i: number) => P + (i * (W - 2 * P)) / (sparkPts.length - 1);
              const y = (v: number) => (mx === mn ? H / 2 : (H - P) - ((v - mn) / (mx - mn)) * (H - 2 * P));
              return (
                <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true"
                  style={{ opacity: 0.9 }}>
                  <title>{sparkPts.map((p) => `${p.period}: ${p.score}`).join(' · ')}</title>
                  <polyline fill="none" stroke="var(--secondary)" strokeWidth={1.5}
                    strokeLinejoin="round" strokeLinecap="round"
                    points={sparkPts.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')} />
                  <circle cx={x(sparkPts.length - 1)} cy={y(vals[vals.length - 1])} r={2} fill="var(--secondary)" />
                </svg>
              );
            })()}
          </div>
          <div className="dq-kpi-sub">avg across {fmtInt(rows.length)} active projects · vs prior {granularity === 'monthly' ? 'month' : granularity === 'quarterly' ? 'quarter' : 'FY'}</div>
        </div>
        <div className="dq-kpi" title="Every record on every project's fix-list for this period — the actual cleanup workload">
          <div className="dq-kpi-label">Records to Fix</div>
          <div className="dq-kpi-val">{sysKpi ? fmtInt(sysKpi.fixTotal) : '—'}</div>
          <div className="dq-kpi-sub">
            {sysKpi ? <>across {fmtInt(sysKpi.fixProjects)} projects{sysKpi.topMetric ? <> · biggest: {METRIC_SHORT[sysKpi.topMetric] ?? sysKpi.topMetric} ({fmtInt(sysKpi.topCount)})</> : null}</> : 'no fix-list data'}
          </div>
        </div>
        <div className="dq-kpi" title="Fix-list items cleared, per the refresh-over-refresh ledger (items detected in the last 180 days). Median = typical days from a record appearing on a fix-list to it being fixed.">
          <div className="dq-kpi-label">Fixed · Last 180d</div>
          <div className="dq-kpi-val" style={{ color: 'var(--accent)' }}>{sysKpi ? fmtInt(sysKpi.fixedN) : '—'}</div>
          <div className="dq-kpi-sub">{sysKpi?.medianFix != null ? <>median fix time {sysKpi.medianFix}d</> : 'fix times pending ledger history'}</div>
        </div>
        <div className="dq-kpi" title="Fix-list elements past a Homeless Trust due date with records still on the list">
          <div className="dq-kpi-label">Overdue</div>
          <div className="dq-kpi-val" style={{ color: (sysKpi?.overdueItems ?? 0) > 0 ? 'var(--danger)' : 'var(--accent)' }}>
            {sysKpi ? fmtInt(sysKpi.overdueItems) : '—'}
          </div>
          <div className="dq-kpi-sub">
            {(sysKpi?.overdueItems ?? 0) > 0
              ? <>past due · {fmtInt(sysKpi!.overdueProjects)} project{sysKpi!.overdueProjects === 1 ? '' : 's'}</>
              : 'nothing past a due date'}
          </div>
        </div>
        <div className="dq-kpi" title="The element with the worst system-wide error rate this period (universe-weighted across projects; universes under 50 excluded)">
          <div className="dq-kpi-label">Weakest Spot</div>
          <div className="dq-kpi-val">{kpi.weakest ? `${kpi.weakest.pct}%` : '—'}</div>
          <div className="dq-kpi-sub">{kpi.weakest ? <>{kpi.weakest.label} · of {fmtInt(kpi.weakest.denom)}</> : 'no qualifying universes'}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <div><h3>Data Quality · APR Q6</h3><div className="meta">
            {fmtInt(sorted.length)} projects · {periodLabel(period)} · click a column to sort
            {' '}· <a href="/dashboard/dq/users">error rates by user →</a>
            {' · click a project name for its fix-list'}
          </div></div>
          <div style={{ position: 'relative' }}>
            <button className="btn" onClick={() => setColsOpen((o) => !o)}>Columns {colsOpen ? '▴' : '▾'}</button>
            {colsOpen && (
              <div style={{
                position: 'absolute', right: 0, top: '110%', zIndex: 30,
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8,
                padding: '10px 14px', display: 'grid', gap: 6, minWidth: 180,
                boxShadow: '0 8px 24px rgba(0,0,0,.35)',
              }}>
                {TOGGLE_COLS.map((c) => (
                  <label key={c.k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={vis(c.k)} onChange={() => toggleCol(c.k)} />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* scroll-pin: viewport-bounded so the horizontal scrollbar is always
            on screen (was only reachable at the very bottom of the page). */}
        <div className="scroll scroll-pin">
          <table>
            <thead>
              <tr>
                <th className={th('name')} onClick={() => toggleSort('name')}>Project {car('name')}</th>
                <th className={th('type_name')} onClick={() => toggleSort('type_name')}>Type {car('type_name')}</th>
                <th className={th('DQ_Score', true)} onClick={() => toggleSort('DQ_Score')}>Overall {car('DQ_Score')}</th>
                {vis('pii') && <th className={th('DQ_PII_Score', true)} onClick={() => toggleSort('DQ_PII_Score')}>Q6a PII {car('DQ_PII_Score')}</th>}
                {vis('univ') && <th className={th('DQ_Univ_Score', true)} onClick={() => toggleSort('DQ_Univ_Score')}>Q6b Universal {car('DQ_Univ_Score')}</th>}
                {vis('inc') && <th className={th('DQ_Inc_Score', true)} onClick={() => toggleSort('DQ_Inc_Score')}
                  title="Full APR Q6c: income at entry AND exit — missing, don't-know/refused, or a yes/no answer that contradicts the source rows">Q6c Income {car('DQ_Inc_Score')}</th>}
                {vis('chronic') && <th className={th('DQ_Chronic_Score', true)} onClick={() => toggleSort('DQ_Chronic_Score')}>Q6d Chronic {car('DQ_Chronic_Score')}</th>}
                {vis('movein') && <th className={th('DQ_MoveIn_pct', true)} onClick={() => toggleSort('DQ_MoveIn_pct')}
                  title="LOCAL metric (no APR Q6 row) — PH stayers enrolled before the period still missing a valid move-in, plus out-of-range move-in dates">Move-In Missing % {car('DQ_MoveIn_pct')}</th>}
                {vis('annual') && <th className={th('DQ_Annual_pct', true)} onClick={() => toggleSort('DQ_Annual_pct')}
                  title="APR Q6c row 4 — income at the annual assessment missing/unknown/conflicting, of adult/HoH stayers due one (HoH anniversary ±30d)">Annual Income % {car('DQ_Annual_pct')}</th>}
                {vis('integrity') && <th className={th('DQ_Integrity_Score', true)} onClick={() => toggleSort('DQ_Integrity_Score')}
                  title="LOCAL category (no APR Q6 row), included in Overall — Eva-derived checks not counted anywhere else in the score: duplicate enrollments, future-dated exits, entered before born, homelessness start after entry, children-only households. Warnings 75 (entry after creation) and 143 (age >100) are worklist-only by design; household-head and overlapping-stay issues are already scored under Q6b. Unique clients failing any, per period.">Integrity {car('DQ_Integrity_Score')}</th>}
                {vis('fixtime') && <th className={th('DQ_FixMedian', true)} onClick={() => toggleSort('DQ_FixMedian')}
                  title="Provider responsiveness — median days from an error appearing on the fix-list to the record's actual DateUpdated clean date (last 180 days of fixes). Sub-line: fixes counted · units open 30+ days.">Fix time {car('DQ_FixMedian')}</th>}
                {vis('household') && <th title={`Household checks — no/multiple head of household, missing relationship, children-only (clients flagged, by severity)${evaWhen}`}>Household</th>}
                {vis('dates') && <th title={`Date checks — future exits, exit before entry, future entries, DOB conflicts, move-in outside the stay, homelessness start after entry (clients flagged, by severity)${evaWhen}`}>Dates</th>}
                {vis('dupes') && <th title={`Duplicate enrollments — same client, project, and entry date (clients flagged)${evaWhen}`}>Duplicates</th>}
                {vis('active') && <th className={th('DQ_ActiveTotal', true)} onClick={() => toggleSort('DQ_ActiveTotal')}>Active {car('DQ_ActiveTotal')}</th>}
                {vis('exits') && <th className={th('DQ_ExitsTotal', true)} onClick={() => toggleSort('DQ_ExitsTotal')}>Exits {car('DQ_ExitsTotal')}</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const d = r.d;
                const isPH = (d.DQ_PHEnrolls || 0) > 0;
                const hasChronic = (d.DQ_ChronicUniverse || 0) > 0;
                return (
                  <tr key={r.project_id}>
                    <td>
                      {canFix
                        ? <span className="nm pp-link" role="button" tabIndex={0}
                            title="Open this project’s data-quality fix-list"
                            onClick={() => setFixRow(r)}
                            onKeyDown={(e) => e.key === 'Enter' && setFixRow(r)}>{r.name}</span>
                        : <span className="nm">{r.name}</span>}
                      {(overdue[r.project_id]?.length ?? 0) > 0 && (
                        <span style={{ marginLeft: 6, color: 'var(--danger)', fontWeight: 700, fontSize: 12 }}
                          title={`Past a Homeless Trust due date with records still to fix: ${overdue[r.project_id].join(', ')}`}>
                          ⚑
                        </span>
                      )}
                    </td>
                    <td><span className="ty">{r.type_name}</span></td>
                    <td className="num"><Gauge score={d.DQ_Score} /></td>
                    {vis('pii') && <td className="num"><ScorePill v={d.DQ_PII_Score} /></td>}
                    {vis('univ') && <td className="num"><ScorePill v={d.DQ_Univ_Score} /></td>}
                    {vis('inc') && <td className="num"><ScorePill v={d.DQ_Inc_Score} /></td>}
                    {vis('chronic') && <td className="num">{hasChronic ? <ScorePill v={d.DQ_Chronic_Score} /> : <span style={{ color: 'var(--muted)' }}>N/A</span>}</td>}
                    {vis('movein') && (isPH
                      ? <PctCell pct={d.DQ_MoveIn_pct} thr={10} sub={d.DQ_PHEnrolls ? `${d.DQ_MoveInBad || 0} of ${d.DQ_PHEnrolls} enrolled` : null} />
                      : <td className="num" style={{ color: 'var(--muted)' }}>N/A</td>)}
                    {vis('annual') && <PctCell pct={d.DQ_Annual_pct} thr={20} sub={d.DQ_AnnualDue ? `${d.DQ_AnnualBad || 0} of ${d.DQ_AnnualDue} due` : null} />}
                    {vis('integrity') && <td className="num"><ScorePill v={d.DQ_Integrity_Score} /></td>}
                    {vis('fixtime') && (
                      <td className="num">
                        {d.DQ_FixMedian == null
                          ? <span style={{ color: 'var(--muted)' }}>{(d.DQ_FixN ?? 0) === 0 ? '—' : 'N/A'}</span>
                          : <>{d.DQ_FixMedian}d<div className="dqsub">{d.DQ_FixN ?? 0} fixed{(d.DQ_Open30 ?? 0) > 0 ? ` · ${d.DQ_Open30} open 30d+` : ''}</div></>}
                      </td>
                    )}
                    {vis('household') && <td><ChecksCell c={evaCounts?.[r.project_id]?.['Household']} /></td>}
                    {vis('dates') && <td><ChecksCell c={evaCounts?.[r.project_id]?.['Dates']} /></td>}
                    {vis('dupes') && <td><ChecksCell c={evaCounts?.[r.project_id]?.['Duplicates']} /></td>}
                    {vis('active') && <td className="num">{fmtInt(d.DQ_ActiveTotal)}</td>}
                    {vis('exits') && <td className="num">{fmtInt(d.DQ_ExitsTotal)}</td>}
                  </tr>
                );
              })}
              {sorted.length === 0 && <tr><td colSpan={3 + visible.size} className="empty">No data quality records for this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {fixRow && (
        <DqFixList
          projectId={fixRow.project_id}
          projectName={fixRow.name}
          period={period}
          data={fixRow.d}
          onClose={() => setFixRow(null)}
        />
      )}
    </>
  );
}
