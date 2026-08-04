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
};

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
  { k: 'annual', label: 'Annual Overdue' },
  { k: 'household', label: 'Household checks' },
  { k: 'dates', label: 'Date checks' },
  { k: 'dupes', label: 'Duplicates' },
  { k: 'active', label: 'Active' },
  { k: 'exits', label: 'Exits' },
];
const COLS_LS_KEY = 'dq_visible_cols_v1';

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

export default function DqView({ periods, granularity, period, rows, evaCounts, focusProject = null }: Props) {
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
  // Fix-list drills into client IDs, which drill_clients only holds monthly.
  const canFix = granularity === 'monthly';
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

  // KPI aggregates (client-weighted), matching renderDQ.
  const kpi = useMemo(() => {
    const sum = (f: (r: Row) => number) => filtered.reduce((s, r) => s + f(r), 0);
    const totalActive = sum((r) => r.d.DQ_ActiveTotal || 0);
    const totalExits = sum((r) => r.d.DQ_ExitsTotal || 0);
    const annualDue = sum((r) => r.d.DQ_AnnualDue || 0);
    const valid = filtered.map((r) => r.d.DQ_Score).filter((v): v is number => v != null);
    const avgScore = valid.length ? +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1) : null;
    const agg = (pctKey: string, wKey: string) => {
      const w = sum((r) => r.d[wKey] || 0);
      if (!w) return null;
      const v = filtered.reduce((s, r) => s + ((r.d[pctKey] || 0) / 100) * (r.d[wKey] || 0), 0);
      return +(v / w * 100).toFixed(1);
    };
    return {
      avgScore, totalActive, totalExits, annualDue,
      destPct: agg('DQ_Dest_pct', 'DQ_ExitsTotal'),
      incMissPct: agg('DQ_IncMiss_pct', 'DQ_ActiveTotal'),
      annualPct: agg('DQ_Annual_pct', 'DQ_AnnualDue'),
    };
  }, [filtered]);

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
        </div>
      </div>

      <div className="dq-kpi-grid">
        <div className="dq-kpi">
          <div className="dq-kpi-label">System DQ Score</div>
          <div className="dq-kpi-val">{kpi.avgScore != null ? <span className={`dq-score-pill ${scoreClass(kpi.avgScore)}`} style={{ fontSize: 20 }}>{kpi.avgScore}%</span> : '—'}</div>
          <div className="dq-kpi-sub">avg across {fmtInt(filtered.length)} active projects</div>
        </div>
        <div className="dq-kpi">
          <div className="dq-kpi-label">Missing Destination</div>
          <div className="dq-kpi-val">{kpi.destPct != null ? `${kpi.destPct}%` : '—'}</div>
          <div className="dq-kpi-sub">of {fmtInt(kpi.totalExits)} exits</div>
        </div>
        <div className="dq-kpi">
          <div className="dq-kpi-label">Missing Entry Income</div>
          <div className="dq-kpi-val">{kpi.incMissPct != null ? `${kpi.incMissPct}%` : '—'}</div>
          <div className="dq-kpi-sub">missing entry record · {fmtInt(kpi.totalActive)} active</div>
        </div>
        <div className="dq-kpi">
          <div className="dq-kpi-label">Overdue Annual Assessment</div>
          <div className="dq-kpi-val">{kpi.annualPct != null ? `${kpi.annualPct}%` : '—'}</div>
          <div className="dq-kpi-sub">of {fmtInt(kpi.annualDue)} due (±30d anniversary)</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <div><h3>Data Quality · APR Q6</h3><div className="meta">
            {fmtInt(sorted.length)} projects · {periodLabel(period)} · click a column to sort
            {canFix
              ? ' · click a project name for its fix-list'
              : ' · switch to the monthly view for the per-record fix-list'}
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
                {vis('movein') && <th className={th('DQ_MoveIn_pct', true)} onClick={() => toggleSort('DQ_MoveIn_pct')}>Move-In Missing % {car('DQ_MoveIn_pct')}</th>}
                {vis('annual') && <th className={th('DQ_Annual_pct', true)} onClick={() => toggleSort('DQ_Annual_pct')}>Annual Overdue % {car('DQ_Annual_pct')}</th>}
                {vis('household') && <th title="Household checks — no/multiple head of household, missing relationship, children-only (clients flagged, by severity)">Household</th>}
                {vis('dates') && <th title="Date checks — future exits, exit before entry, future entries, DOB conflicts, move-in outside the stay (clients flagged, by severity)">Dates</th>}
                {vis('dupes') && <th title="Duplicate enrollments — same client, project, and entry date (clients flagged)">Duplicates</th>}
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
