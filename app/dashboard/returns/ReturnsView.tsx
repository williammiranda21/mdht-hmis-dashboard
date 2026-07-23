'use client';

/*
 * Returns to Homelessness (SPM Measure 2) — port of renderReturns()/_renderRetDestTable()
 * in apr_monthly_report.py. Counts are precomputed per project (returns_metrics); rates are
 * band ÷ total PH exits (the exact source formula). Returns only exist for periods with a
 * full 24-month lookback, so the period list comes from meta.ret_periods. Flag threshold 20%.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity } from '../../../lib/types';
import { HOUSEHOLD_OPTIONS, SUBPOPULATION_OPTIONS } from '../../../lib/types';
import { periodLabel, lookbackLabel, fmtInt, DEST_LABELS } from '../../../lib/format';

type Row = {
  project_id: number; name: string; type_name: string; project_type: number | null;
  exits: number; lt6: number; r6: number; r13: number; r2: number;
};
type Props = {
  periods: string[]; granularity: Granularity; period: string; household: string; subpopulation: string;
  rows: Row[]; destAgg: Record<string, { exits: number; returns: number }>;
};

const rate = (band: number, exits: number): number | null => (exits > 0 ? +((band / exits) * 100).toFixed(1) : null);

type SortKey = 'name' | 'type_name' | 'exits' | 'lt6' | 'rlt6' | 'r6' | 'rr6' | 'r13' | 'rr13' | 'r2' | 'rr2';

export default function ReturnsView({ periods, granularity, period, household, subpopulation, rows, destAgg }: Props) {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('exits');
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
    const val = (r: Row): number | string => {
      switch (sortKey) {
        case 'name': return r.name;
        case 'type_name': return r.type_name;
        case 'exits': return r.exits;
        case 'lt6': return r.lt6;
        case 'rlt6': return rate(r.lt6, r.exits) ?? -1;
        case 'r6': return r.r6;
        case 'rr6': return rate(r.r6, r.exits) ?? -1;
        case 'r13': return r.r13;
        case 'rr13': return rate(r.r13, r.exits) ?? -1;
        case 'r2': return r.r2;
        case 'rr2': return rate(r.r2, r.exits) ?? -1;
      }
    };
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * sortDir;
      return (x - y) * sortDir;
    });
  }, [filtered, sortKey, sortDir]);

  const tot = useMemo(() => {
    const s = { exits: 0, lt6: 0, r6: 0, r13: 0, r2: 0 };
    filtered.forEach((r) => { s.exits += r.exits; s.lt6 += r.lt6; s.r6 += r.r6; s.r13 += r.r13; s.r2 += r.r2; });
    return s;
  }, [filtered]);

  const destEntries = useMemo(() => {
    const e = Object.entries(destAgg)
      .map(([code, v]) => ({ code: +code, exits: v.exits, returns: v.returns, rate: v.exits > 0 ? +((v.returns / v.exits) * 100).toFixed(1) : null, label: DEST_LABELS[+code] || `Destination ${code}` }))
      .filter((x) => x.exits > 0)
      .sort((a, b) => (b.rate || 0) - (a.rate || 0));
    return e;
  }, [destAgg]);
  const maxDestRate = Math.max(...destEntries.map((e) => e.rate || 0), 1);

  function navigate(patch: Partial<{ g: string; p: string; hh: string; sub: string }>) {
    const sp = new URLSearchParams();
    sp.set('g', patch.g ?? granularity);
    if (!('g' in patch) || patch.g === granularity) sp.set('p', patch.p ?? period);
    sp.set('hh', patch.hh ?? household);
    sp.set('sub', patch.sub ?? subpopulation);
    router.push(`/dashboard/returns?${sp.toString()}`);
  }
  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === 'name' || k === 'type_name' ? 1 : -1); }
  }
  const car = (k: SortKey) => <span className="car">{sortKey === k ? (sortDir < 0 ? '▼' : '▲') : '▼'}</span>;
  const th = (k: SortKey, num = true) => `sortable${num ? ' num' : ''}${sortKey === k ? ' sorted' : ''}`;

  // KPI band rate + color class
  const kpiPct = (n: number) => (tot.exits > 0 ? `${((n / tot.exits) * 100).toFixed(1)}%` : 'N/A');
  const kpiCls = (n: number) => (tot.exits === 0 ? 'amber' : (n / tot.exits) * 100 >= 20 ? 'red-flag' : 'green');
  const kpiSub = (n: number) => (tot.exits > 0 ? `${fmtInt(n)} of ${fmtInt(tot.exits)} exits · flag ≥20%` : 'flag ≥20%');

  // per-project rate cell
  const RateCell = ({ band, exits }: { band: number; exits: number }) => {
    const v = rate(band, exits);
    if (v == null) return <td className="num">—</td>;
    const flag = v >= 20;
    return <td className={`num ${flag ? 'cell-ph-flag' : band > 0 ? 'cell-good-flag' : ''}`}>{v}%{flag ? ' ⚠' : ''}</td>;
  };

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
            <span className="flabel">Household type</span>
            <select className="fselect" value={household} onChange={(e) => navigate({ hh: e.target.value })}>
              {HOUSEHOLD_OPTIONS.map((h) => <option key={h} value={h}>{h === 'All' ? 'All households' : h}</option>)}
            </select>
          </div>
          <div className="fgroup">
            <span className="flabel">Subpopulation</span>
            <select className="fselect" value={subpopulation} onChange={(e) => navigate({ sub: e.target.value })}>
              {SUBPOPULATION_OPTIONS.map((s) => <option key={s} value={s}>{s === 'All' ? 'All clients' : s}</option>)}
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

      <div className="ret-kpi-grid">
        <div className="ret-kpi"><div className="ret-kpi-label">Projects</div><div className="ret-kpi-val">{fmtInt(filtered.length)}</div><div className="ret-kpi-sub">with PH exits in window</div></div>
        <div className="ret-kpi"><div className="ret-kpi-label">PH Exits (universe)</div><div className="ret-kpi-val">{fmtInt(tot.exits)}</div><div className="ret-kpi-sub">24-mo lookback: {lookbackLabel(period)}</div></div>
        <div className={`ret-kpi ${kpiCls(tot.lt6)}`}><div className="ret-kpi-label">Return &lt; 6 mo</div><div className="ret-kpi-val">{kpiPct(tot.lt6)}</div><div className="ret-kpi-sub">{kpiSub(tot.lt6)}</div></div>
        <div className={`ret-kpi ${kpiCls(tot.r6)}`}><div className="ret-kpi-label">Return 6–12 mo</div><div className="ret-kpi-val">{kpiPct(tot.r6)}</div><div className="ret-kpi-sub">{kpiSub(tot.r6)}</div></div>
        <div className={`ret-kpi ${kpiCls(tot.r13)}`}><div className="ret-kpi-label">Return 13–24 mo</div><div className="ret-kpi-val">{kpiPct(tot.r13)}</div><div className="ret-kpi-sub">{kpiSub(tot.r13)}</div></div>
        <div className={`ret-kpi ${kpiCls(tot.r2)}`}><div className="ret-kpi-label">2-yr return rate</div><div className="ret-kpi-val">{kpiPct(tot.r2)}</div><div className="ret-kpi-sub">{kpiSub(tot.r2)}</div></div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <div><h3>Returns to Homelessness — by project</h3><div className="meta">{fmtInt(sorted.length)} projects · {fmtInt(tot.exits)} PH exits · 24-mo lookback: {lookbackLabel(period)}</div></div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className={th('name', false)} onClick={() => toggleSort('name')}>Project {car('name')}</th>
                <th className={th('type_name', false)} onClick={() => toggleSort('type_name')}>Type {car('type_name')}</th>
                <th className={th('exits')} onClick={() => toggleSort('exits')}>PH Exits {car('exits')}</th>
                <th className={th('lt6')} onClick={() => toggleSort('lt6')}>&lt;6mo {car('lt6')}</th>
                <th className={th('rlt6')} onClick={() => toggleSort('rlt6')}>Rate {car('rlt6')}</th>
                <th className={th('r6')} onClick={() => toggleSort('r6')}>6–12mo {car('r6')}</th>
                <th className={th('rr6')} onClick={() => toggleSort('rr6')}>Rate {car('rr6')}</th>
                <th className={th('r13')} onClick={() => toggleSort('r13')}>13–24mo {car('r13')}</th>
                <th className={th('rr13')} onClick={() => toggleSort('rr13')}>Rate {car('rr13')}</th>
                <th className={th('r2')} onClick={() => toggleSort('r2')}>2yr Returns {car('r2')}</th>
                <th className={th('rr2')} onClick={() => toggleSort('rr2')}>2yr Rate {car('rr2')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.project_id}>
                  <td><span className="nm">{r.name}</span></td>
                  <td><span className="ty">{r.type_name}</span></td>
                  <td className="num"><strong>{fmtInt(r.exits)}</strong></td>
                  <td className="num">{fmtInt(r.lt6)}</td>
                  <RateCell band={r.lt6} exits={r.exits} />
                  <td className="num">{fmtInt(r.r6)}</td>
                  <RateCell band={r.r6} exits={r.exits} />
                  <td className="num">{fmtInt(r.r13)}</td>
                  <RateCell band={r.r13} exits={r.exits} />
                  <td className="num"><strong>{fmtInt(r.r2)}</strong></td>
                  <RateCell band={r.r2} exits={r.exits} />
                </tr>
              ))}
              {sorted.length === 0 && <tr><td colSpan={11} className="empty">No returns data matches these filters.</td></tr>}
            </tbody>
            {sorted.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total · {fmtInt(sorted.length)} projects</td><td />
                  <td className="num">{fmtInt(tot.exits)}</td>
                  <td className="num">{fmtInt(tot.lt6)}</td><td className="num">{kpiPct(tot.lt6)}</td>
                  <td className="num">{fmtInt(tot.r6)}</td><td className="num">{kpiPct(tot.r6)}</td>
                  <td className="num">{fmtInt(tot.r13)}</td><td className="num">{kpiPct(tot.r13)}</td>
                  <td className="num">{fmtInt(tot.r2)}</td><td className="num">{kpiPct(tot.r2)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="grouplabel">Returns by prior-exit destination</div>
      <div className="panel">
        <div className="panel-h">
          <div><h3>Return rate by destination</h3><div className="meta">{destEntries.length} destination types · sorted by return rate</div></div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Prior PH destination</th><th className="num">Exits</th><th className="num">Returns</th><th className="num">Return rate</th><th style={{ width: 180 }} /></tr>
            </thead>
            <tbody>
              {destEntries.map((e) => {
                const rn = e.rate || 0;
                const col = rn >= 20 ? 'var(--danger)' : rn >= 10 ? 'var(--warn)' : 'var(--accent)';
                return (
                  <tr key={e.code}>
                    <td>{e.label} <span className="ty">{e.code}</span></td>
                    <td className="num">{fmtInt(e.exits)}</td>
                    <td className="num">{fmtInt(e.returns)}</td>
                    <td className="num" style={{ color: col, fontWeight: rn >= 20 ? 700 : 400 }}>{e.rate != null ? `${e.rate}%` : '—'}{rn >= 20 ? ' ⚠' : ''}</td>
                    <td><div className="rdbar"><i style={{ width: `${(rn / maxDestRate) * 100}%`, background: col }} /></div></td>
                  </tr>
                );
              })}
              {destEntries.length === 0 && <tr><td colSpan={5} className="empty">No destination breakdown for this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
