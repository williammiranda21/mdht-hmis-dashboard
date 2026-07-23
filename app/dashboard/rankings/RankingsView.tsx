'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity, ProjectMetric } from '../../../lib/types';
import { HOUSEHOLD_OPTIONS, SUBPOPULATION_OPTIONS } from '../../../lib/types';
import { periodLabel, fmtInt } from '../../../lib/format';

type Props = {
  rows: ProjectMetric[];
  periods: string[];
  granularity: Granularity;
  period: string;
  household: string;
  subpopulation: string;
};

const METRICS: { key: keyof ProjectMetric; label: string; pct?: boolean; unit?: string }[] = [
  { key: 'ph_exit_rate', label: 'PH exit rate', pct: true },
  { key: 'clients_served', label: 'Clients served' },
  { key: 'leavers', label: 'Leavers' },
  { key: 'exits_ph', label: 'Exits to PH' },
  { key: 'unsub_rate', label: 'Unsubsidized rate', pct: true },
  { key: 'exits_unsub', label: 'Exits to unsubsidized' },
  { key: 'avg_los', label: 'Avg length of stay', unit: 'd' },
];

const N_OPTIONS = [10, 25, 50, 0]; // 0 = All

export default function RankingsView({ rows, periods, granularity, period, household, subpopulation }: Props) {
  const router = useRouter();
  const [metricKey, setMetricKey] = useState<keyof ProjectMetric>('ph_exit_rate');
  const [topN, setTopN] = useState(25);
  const [typeFilter, setTypeFilter] = useState('All');
  const [activeOnly, setActiveOnly] = useState(true);

  const metric = METRICS.find((m) => m.key === metricKey)!;

  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.type_name && s.add(r.type_name));
    return ['All', ...Array.from(s).sort()];
  }, [rows]);

  const ranked = useMemo(() => {
    const list = rows
      .filter((r) => (typeFilter === 'All' || r.type_name === typeFilter))
      .filter((r) => (!activeOnly || (r.clients_served && r.clients_served > 0)))
      .filter((r) => r[metricKey] != null)
      .sort((a, b) => (b[metricKey] as number) - (a[metricKey] as number));
    return topN === 0 ? list : list.slice(0, topN);
  }, [rows, typeFilter, activeOnly, metricKey, topN]);

  const max = ranked.length ? Math.max(...ranked.map((r) => r[metricKey] as number)) : 0;

  function navigate(patch: Partial<{ g: string; p: string; hh: string; sub: string }>) {
    const sp = new URLSearchParams();
    sp.set('g', patch.g ?? granularity);
    if (!('g' in patch) || patch.g === granularity) sp.set('p', patch.p ?? period);
    sp.set('hh', patch.hh ?? household);
    sp.set('sub', patch.sub ?? subpopulation);
    router.push(`/dashboard/rankings?${sp.toString()}`);
  }

  const fmtVal = (v: number) => (metric.pct ? `${v.toFixed(1)}%` : metric.unit === 'd' ? `${Math.round(v)}d` : fmtInt(v));

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
            <span className="flabel">Rank by</span>
            <select className="fselect" value={metricKey as string} onChange={(e) => setMetricKey(e.target.value as keyof ProjectMetric)}>
              {METRICS.map((m) => <option key={m.key as string} value={m.key as string}>{m.label}</option>)}
            </select>
          </div>
          <div className="fgroup">
            <span className="flabel">Show top</span>
            <select className="fselect" value={topN} onChange={(e) => setTopN(+e.target.value)} style={{ minWidth: 110 }}>
              {N_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'All' : `Top ${n}`}</option>)}
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
          <div className={`switch${activeOnly ? '' : ' off'}`} onClick={() => setActiveOnly((v) => !v)}>
            <span className="tk" />Active only
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <div><h3>Rankings · {metric.label}</h3><div className="meta">{periodLabel(period)} · {ranked.length === rows.length ? 'all' : `top ${ranked.length}`} projects</div></div>
        </div>
        <div className="rklist">
          {ranked.map((r, i) => {
            const v = r[metricKey] as number;
            const w = max > 0 ? (v / max) * 100 : 0;
            return (
              <div className="rkrow" key={r.project_id}>
                <span className="rank">{i + 1}</span>
                {/* .nm is ellipsised at 300px, so carry the full name in a title */}
                <span className="pnm" title={r.type_name ? `${r.project_name} · ${r.type_name}` : r.project_name ?? ''}>
                  <span className="nm">{r.project_name}</span>
                  <span className="ty">{r.type_name}</span>
                </span>
                <span className="rkbar"><i style={{ width: `${w}%` }} /></span>
                <span className="rkval">{fmtVal(v)}</span>
              </div>
            );
          })}
          {ranked.length === 0 && <div className="empty">No projects match these filters.</div>}
        </div>
      </div>
    </>
  );
}
