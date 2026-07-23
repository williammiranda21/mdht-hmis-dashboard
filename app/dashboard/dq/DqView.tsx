'use client';

/*
 * Data Quality (APR Q6) tab — port of renderDQ() in apr_monthly_report.py.
 * Scores/percentages are precomputed per project in dq_metrics.data; this view
 * only aggregates the KPI cards and applies the score bands. Band rules (match source):
 *   score cells: >=80 green, >=60 amber, else red.
 *   "missing %" cells: 0% good, <=threshold normal, > threshold red (move-in thr 10, annual thr 20).
 *   KPI percents are client-weighted (Σ pct/100 * weight ÷ Σ weight).
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity } from '../../../lib/types';
import { periodLabel, fmtInt } from '../../../lib/format';

type DqRecord = Record<string, number | null>;
type Row = { project_id: number; name: string; type_name: string; project_type: number | null; d: DqRecord };

type Props = { periods: string[]; granularity: Granularity; period: string; rows: Row[] };

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

export default function DqView({ periods, granularity, period, rows }: Props) {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('DQ_Score');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

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
          <div><h3>Data Quality · APR Q6</h3><div className="meta">{fmtInt(sorted.length)} projects · {periodLabel(period)} · click a column to sort</div></div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className={th('name')} onClick={() => toggleSort('name')}>Project {car('name')}</th>
                <th className={th('type_name')} onClick={() => toggleSort('type_name')}>Type {car('type_name')}</th>
                <th className={th('DQ_Score', true)} onClick={() => toggleSort('DQ_Score')}>Overall {car('DQ_Score')}</th>
                <th className={th('DQ_PII_Score', true)} onClick={() => toggleSort('DQ_PII_Score')}>Q6a PII {car('DQ_PII_Score')}</th>
                <th className={th('DQ_Univ_Score', true)} onClick={() => toggleSort('DQ_Univ_Score')}>Q6b Universal {car('DQ_Univ_Score')}</th>
                <th className={th('DQ_Inc_Score', true)} onClick={() => toggleSort('DQ_Inc_Score')}>Q6c Income {car('DQ_Inc_Score')}</th>
                <th className={th('DQ_Chronic_Score', true)} onClick={() => toggleSort('DQ_Chronic_Score')}>Q6d Chronic {car('DQ_Chronic_Score')}</th>
                <th className={th('DQ_MoveIn_pct', true)} onClick={() => toggleSort('DQ_MoveIn_pct')}>Move-In Missing % {car('DQ_MoveIn_pct')}</th>
                <th className={th('DQ_Annual_pct', true)} onClick={() => toggleSort('DQ_Annual_pct')}>Annual Overdue % {car('DQ_Annual_pct')}</th>
                <th className={th('DQ_ActiveTotal', true)} onClick={() => toggleSort('DQ_ActiveTotal')}>Active {car('DQ_ActiveTotal')}</th>
                <th className={th('DQ_ExitsTotal', true)} onClick={() => toggleSort('DQ_ExitsTotal')}>Exits {car('DQ_ExitsTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const d = r.d;
                const isPH = (d.DQ_PHEnrolls || 0) > 0;
                const hasChronic = (d.DQ_ChronicUniverse || 0) > 0;
                return (
                  <tr key={r.project_id}>
                    <td><span className="nm">{r.name}</span></td>
                    <td><span className="ty">{r.type_name}</span></td>
                    <td className="num"><Gauge score={d.DQ_Score} /></td>
                    <td className="num"><ScorePill v={d.DQ_PII_Score} /></td>
                    <td className="num"><ScorePill v={d.DQ_Univ_Score} /></td>
                    <td className="num"><ScorePill v={d.DQ_Inc_Score} /></td>
                    <td className="num">{hasChronic ? <ScorePill v={d.DQ_Chronic_Score} /> : <span style={{ color: 'var(--muted)' }}>N/A</span>}</td>
                    {isPH
                      ? <PctCell pct={d.DQ_MoveIn_pct} thr={10} sub={d.DQ_PHEnrolls ? `${d.DQ_MoveInBad || 0} of ${d.DQ_PHEnrolls} enrolled` : null} />
                      : <td className="num" style={{ color: 'var(--muted)' }}>N/A</td>}
                    <PctCell pct={d.DQ_Annual_pct} thr={20} sub={d.DQ_AnnualDue ? `${d.DQ_AnnualBad || 0} of ${d.DQ_AnnualDue} due` : null} />
                    <td className="num">{fmtInt(d.DQ_ActiveTotal)}</td>
                    <td className="num">{fmtInt(d.DQ_ExitsTotal)}</td>
                  </tr>
                );
              })}
              {sorted.length === 0 && <tr><td colSpan={11} className="empty">No data quality records for this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
