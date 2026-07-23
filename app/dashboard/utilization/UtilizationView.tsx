'use client';

/*
 * Unit Utilization — port of the dashboard_utilization_mockup + renderUtil() logic.
 * Values come precomputed in util_metrics.data:
 *   hh[All|Individuals|Families] = {c:cap, o:avg-occ, u:avg-util%, p:pit-occ, pu:pit-util%, bt:[[type,cap,avg%,pit%]]}
 *   unit = same shape for scattered-site RRH/PH (lease-up; can exceed 100%)
 *   empty, over, under, projects[{n,t,k,cap,occ,util,pit,putil}]
 *
 * Project-type filter (added 2026-06): "All types" shows the precomputed system
 * aggregates + the Individuals/Families household toggle. A specific type drives the
 * relevant card from that type's `bt` figures — which the "All" cards are exactly the
 * capacity-weighted combination of, so per-type stays consistent with the headline
 * numbers (and with the scattered-site lease-up method). occ for a type = cap*util/100.
 * Household splits aren't available per-type, so the toggle is disabled when a type is set.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity } from '../../../lib/types';
import type { UtilRecord, UtilHH, UtilProject } from '../../../lib/queries';
import { periodLabel, fmtInt } from '../../../lib/format';

type Props = { periods: string[]; granularity: Granularity; period: string; util: UtilRecord };
type Method = 'avg' | 'pit';

const FIXED_TYPES = ['ES', 'TH', 'SH', 'PSH'];
const SCATTER_TYPES = ['RRH', 'PH'];

const uColor = (v: number | null) =>
  v == null ? 'var(--muted)' : v > 110 ? 'var(--mid)' : v >= 85 ? 'var(--accent)' : v >= 65 ? 'var(--warn)' : 'var(--danger)';
const uPill = (v: number | null): 'good' | 'warn' | 'bad' =>
  v == null ? 'warn' : v > 110 ? 'warn' : v >= 85 ? 'good' : v >= 65 ? 'warn' : 'bad';

const ICON_PATHS: Record<string, string> = {
  bed: '<path d="M3 18V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9M3 14h18M7 9v3"/>',
  home: '<path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5"/>',
  empty: '<rect x="3" y="7" width="18" height="11" rx="2"/><path d="M3 12h18"/>',
  alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};
const Icon = ({ n }: { n: string }) => (
  <span className="ic" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[n] || ''}</svg>` }} />
);

type ByType = [string, number, number, number][];
type CardData = { util: number; occ: number; cap: number; byType: ByType | null; vlabel: string; foot: string };

function HeroCard({ icon, tag, title, data, suf, method }: {
  icon: string; tag: string; title: string; data: CardData | null; suf: string; method: Method;
}) {
  if (!data) {
    return (
      <div className="pcard">
        <div className="pc-head"><div className="pc-title"><Icon n={icon} /><span>{title}</span></div><span className="pc-tag">{tag}</span></div>
        <div className="pc-body"><div className="pc-vlabel">Not applicable for this type</div><div className="pc-val" style={{ color: 'var(--faint)' }}>—</div></div>
      </div>
    );
  }
  return (
    <div className="pcard">
      <div className="pc-head"><div className="pc-title"><Icon n={icon} /><span>{title}</span></div><span className="pc-tag">{tag}</span></div>
      <div className="pc-body">
        <div className="pc-vlabel">{data.vlabel}</div>
        <div className="pc-val">{data.util}<span className="suf">%</span></div>
        <div className="ugt">
          <div className="ugf" style={{ width: `${Math.min(100, data.util)}%`, background: uColor(data.util) }} />
          <div className="ugm" style={{ left: '90%' }}><span className="ugd">target 90%</span></div>
        </div>
        <div className="pc-foot" dangerouslySetInnerHTML={{ __html: data.foot }} />
        {data.byType && data.byType.length > 0 && (
          <div className="pc-sec">
            {data.byType.map((r, i) => {
              const v = method === 'avg' ? r[2] : r[3];
              return (
                <div className="brow" key={i}>
                  <span className="bnm">{r[0]} <span style={{ color: 'var(--faint)', fontWeight: 500 }}>{r[1].toLocaleString()} {suf}</span></span>
                  <span className="bmini"><i style={{ width: `${Math.min(100, v)}%`, background: uColor(v) }} /></span>
                  <span className="bvl">{v}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, tag, title, vlabel, val, foot }: { icon: string; tag: string; title: string; vlabel: string; val: React.ReactNode; foot: string }) {
  return (
    <div className="pcard">
      <div className="pc-head"><div className="pc-title"><Icon n={icon} /><span>{title}</span></div><span className="pc-tag">{tag}</span></div>
      <div className="pc-body">
        <div className="pc-vlabel">{vlabel}</div>
        <div className="pc-val">{val}</div>
        <div className="pc-foot" dangerouslySetInnerHTML={{ __html: foot }} />
      </div>
    </div>
  );
}

type SortKey = 'name' | 'cap' | 'occ' | 'util';

export default function UtilizationView({ periods, granularity, period, util }: Props) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>('avg');
  const [hh, setHH] = useState<'All' | 'Individuals' | 'Families'>('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [sortKey, setSortKey] = useState<SortKey>('util');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const projOcc = (p: UtilProject) => (method === 'avg' ? p.occ : p.pit);
  const projUtil = (p: UtilProject) => (method === 'avg' ? p.util : p.putil);

  // Type → {cap, avg%, pit%} from the precomputed bed + unit breakdowns.
  const typeMap = useMemo(() => {
    const m: Record<string, { cap: number; avg: number; pit: number }> = {};
    (util.hh.All.bt || []).forEach(([t, cap, avg, pit]) => { m[t] = { cap, avg, pit }; });
    (util.unit.bt || []).forEach(([t, cap, avg, pit]) => { m[t] = { cap, avg, pit }; });
    return m;
  }, [util]);

  const typeOptions = useMemo(() => {
    const present = new Set(util.projects.map((p) => p.t));
    return ['All', ...[...FIXED_TYPES, ...SCATTER_TYPES].filter((t) => present.has(t))];
  }, [util.projects]);

  const isAll = typeFilter === 'All';
  const bedProjCount = util.projects.filter((p) => p.k === 'beds').length;
  const unitProjCount = util.projects.filter((p) => p.k === 'units').length;

  const filteredProjects = useMemo(
    () => (isAll ? util.projects : util.projects.filter((p) => p.t === typeFilter)),
    [util.projects, typeFilter, isAll],
  );

  // ── Card data, scoped by the type filter ──
  const { bedCard, unitCard, emptyVal, overVal, underVal } = useMemo(() => {
    if (isAll) {
      const HD: UtilHH = util.hh[hh] || util.hh.All;
      const bU = method === 'avg' ? HD.u : HD.pu, bO = method === 'avg' ? HD.o : HD.p;
      const uU = method === 'avg' ? util.unit.u : util.unit.pu, uO = method === 'avg' ? util.unit.o : util.unit.p;
      return {
        bedCard: { util: bU, occ: bO, cap: HD.c, byType: hh === 'All' ? HD.bt ?? null : null,
          vlabel: hh === 'All' ? 'Fixed-bed programs' : `${hh} · fixed-bed`,
          foot: `<b>${bO.toLocaleString()}</b> of ${HD.c.toLocaleString()} beds · ${hh === 'All' ? `${bedProjCount} projects` : hh}` } as CardData,
        unitCard: { util: uU, occ: uO, cap: util.unit.c, byType: util.unit.bt ?? null,
          vlabel: 'Tenant-based · scattered-site',
          foot: `<b>${uO.toLocaleString()}</b> of ${util.unit.c.toLocaleString()} units · ${unitProjCount} projects` } as CardData,
        emptyVal: util.empty, overVal: util.over, underVal: util.under,
      };
    }
    // specific type → drive the relevant card from its bt figures
    const ti = typeMap[typeFilter];
    const u = ti ? (method === 'avg' ? ti.avg : ti.pit) : 0;
    const occ = ti ? Math.round((ti.cap * u) / 100) : 0;
    const over = filteredProjects.filter((p) => projUtil(p) > 110).length;
    const under = filteredProjects.filter((p) => projUtil(p) < 65).length;
    const isFixed = FIXED_TYPES.includes(typeFilter);
    const card: CardData | null = ti ? {
      util: u, occ, cap: ti.cap, byType: null,
      vlabel: `${typeFilter} · ${isFixed ? 'fixed-bed' : 'scattered-site'}`,
      foot: `<b>${occ.toLocaleString()}</b> of ${ti.cap.toLocaleString()} ${isFixed ? 'beds' : 'units'} · ${filteredProjects.length} projects`,
    } : null;
    return {
      bedCard: isFixed ? card : null,
      unitCard: isFixed ? null : card,
      emptyVal: isFixed ? Math.max(0, ti ? ti.cap - occ : 0) : null,
      overVal: over, underVal: under,
    };
  }, [isAll, hh, method, typeFilter, typeMap, filteredProjects, util, bedProjCount, unitProjCount]);

  const rows = useMemo(() => {
    const val = (p: UtilProject): number | string =>
      sortKey === 'name' ? p.n : sortKey === 'cap' ? p.cap : sortKey === 'occ' ? projOcc(p) : projUtil(p);
    return [...filteredProjects].sort((a, b) => {
      const x = val(a), y = val(b);
      return typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) * sortDir : (x - y) * sortDir;
    });
  }, [filteredProjects, sortKey, sortDir, method]);

  function navigate(patch: Partial<{ g: string; p: string }>) {
    const sp = new URLSearchParams();
    sp.set('g', patch.g ?? granularity);
    if (!('g' in patch) || patch.g === granularity) sp.set('p', patch.p ?? period);
    router.push(`/dashboard/utilization?${sp.toString()}`);
  }
  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === 'name' ? 1 : -1); }
  }
  const car = (k: SortKey) => <span className="car">{sortKey === k ? (sortDir < 0 ? '▼' : '▲') : '▼'}</span>;
  const th = (k: SortKey, num = true) => `sortable${num ? ' num' : ''}${sortKey === k ? ' sorted' : ''}`;

  const statusPill = (u: number) =>
    u === 0 ? <span className="pill bad">no occupancy ⚠</span>
      : u > 110 ? <span className="pill warn">over capacity</span>
      : u < 65 ? <span className="pill bad">underused</span>
      : <span className="pill good">healthy</span>;

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
            <span className="flabel">Household type{!isAll && <span style={{ color: 'var(--faint)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}> · all types only</span>}</span>
            <div className="seg" style={isAll ? undefined : { opacity: 0.45, pointerEvents: 'none' }}>
              {(['All', 'Individuals', 'Families'] as const).map((h) => (
                <button key={h} className={isAll && hh === h ? 'on' : ''} onClick={() => setHH(h)} disabled={!isAll}>{h}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="uctl">
        <span className="seglbl">Occupancy</span>
        <div className="seg">
          <button className={method === 'avg' ? 'on' : ''} onClick={() => setMethod('avg')}>Average daily</button>
          <button className={method === 'pit' ? 'on' : ''} onClick={() => setMethod('pit')}>Point-in-time</button>
        </div>
      </div>

      <div className="grid4">
        <HeroCard icon="bed" tag="ES/TH/SH/PSH" title="Bed utilization" data={bedCard} suf="beds" method={method} />
        <HeroCard icon="home" tag="RRH / PH" title="Unit / lease-up" data={unitCard} suf="units" method={method} />
        <StatCard icon="empty" tag="Capacity" title="Empty beds / night" vlabel="Avg unused fixed-bed capacity"
          val={emptyVal == null ? <span style={{ color: 'var(--faint)' }}>—</span> : `~${emptyVal.toLocaleString()}`}
          foot={emptyVal == null ? 'not applicable for scattered-site' : 'beds sitting empty each night'} />
        <StatCard icon="alert" tag="Flags" title="Projects to review" vlabel="Outside healthy band"
          val={<><span style={{ color: 'var(--danger)' }}>{overVal}</span> / <span style={{ color: 'var(--warn)' }}>{underVal}</span></>}
          foot={`<b>${overVal}</b> over capacity · <b>${underVal}</b> under 65%`} />
      </div>

      <div className="grouplabel">Utilization by project{isAll ? '' : ` · ${typeFilter}`}</div>
      <div className="panel">
        <div className="panel-h">
          <div><h3>Project-level utilization</h3><div className="meta">{fmtInt(rows.length)} projects · {periodLabel(period)} · {method === 'avg' ? 'average daily' : 'point-in-time'}</div></div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className={th('name', false)} onClick={() => toggleSort('name')}>Project {car('name')}</th>
                <th className={th('cap')} onClick={() => toggleSort('cap')}>Inventory {car('cap')}</th>
                <th className={th('occ')} onClick={() => toggleSort('occ')}>Occupancy {car('occ')}</th>
                <th className={th('util')} onClick={() => toggleSort('util')}>Utilization {car('util')}</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const u = projUtil(p);
                return (
                  <tr key={`${p.n}-${i}`}>
                    <td><span className="nm">{p.n}</span><span className="ty">{p.t}</span></td>
                    <td className="num">{p.cap.toLocaleString()} {p.k}</td>
                    <td className="num">{projOcc(p).toLocaleString()}</td>
                    <td className="num">
                      <span className="ubar">
                        <span className="mb"><i style={{ width: `${Math.min(100, u)}%`, background: uColor(u) }} /></span>
                        <span className={`pill ${uPill(u)}`}>{u}%</span>
                      </span>
                    </td>
                    <td>{statusPill(u)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="empty">No projects match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
