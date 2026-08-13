'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity, ProjectMetric } from '../../lib/types';
import { HOUSEHOLD_OPTIONS, SUBPOPULATION_OPTIONS } from '../../lib/types';
import { periodLabel, rateBand, bandColorVar, fmtInt } from '../../lib/format';
import { fmtTarget } from '../../lib/target-metrics';
import type { TargetMiss } from '../../lib/target-flags';
import ProjectPanel from './ProjectPanel';
import CopyId from '../../components/CopyId';
import ProjectPicker from '../../components/ProjectPicker';

type Props = {
  rows: ProjectMetric[];
  periods: string[];
  granularity: Granularity;
  period: string;
  household: string;
  subpopulation: string;
  /** project_id → missed targets (empty on filtered household/subpop views). */
  targetFlags?: Record<number, TargetMiss[]>;
  /** meta.partial_period — authoritative in-progress month for the badge. */
  partialPeriod?: string | null;
};

// Extra columns available through the ⚙ Columns picker — pulled from the full jsonb record.
// Labels stay SHORT — long header words set the column's minimum width, and
// the compact table exists to fit 3-4 of these before a horizontal scroll.
const EXTRA_COLUMNS: { key: string; label: string; pct?: boolean }[] = [
  { key: 'ExitsToPosOutreach', label: 'Pos Exits' },
  { key: 'PosOutreachRate', label: 'Pos Rate', pct: true },
  { key: 'SOContacts', label: 'Contacts' },
  { key: 'SOEngagements', label: 'Engaged' },
  { key: 'EarnedIncomeImprovementRate', label: 'Earned Inc %', pct: true },
  { key: 'LOS_0_30', label: 'LOS 0–30' },
  { key: 'LOS_31_90', label: 'LOS 31–90' },
  { key: 'LOS_91_180', label: 'LOS 91–180' },
  { key: 'LOS_181_365', label: 'LOS 181–365' },
  { key: 'LOS_365plus', label: 'LOS 365+' },
  { key: 'SystemInflow', label: 'System Inflow' },
];

type SortKey =
  | 'name' | 'type_name' | 'clients_served' | 'leavers' | 'exits_ph'
  | 'ph_exit_rate' | 'mom' | 'unsub_rate' | 'avg_los' | string;

/** PH-exit-rate change vs the PRIOR PERIOD OF THE SAME GRANULARITY. The ETL
 *  diffs each frame within itself (apr_monthly_report.py DELTA_PAIRS), so the
 *  jsonb field is named MoM_* but holds QoQ on quarterly rows and YoY on
 *  fiscal rows — only the display label should say MoM/QoQ/YoY. */
const mom = (r: ProjectMetric): number | null => {
  const v = r.data?.['MoM_PHExitRate_pp'];
  return typeof v === 'number' ? v : null;
};

const POP_LABEL: Record<string, string> = { monthly: 'MoM', quarterly: 'QoQ', fiscal: 'YoY' };

export default function DashboardView({
  rows, periods, granularity, period, household, subpopulation, targetFlags = {}, partialPeriod = null,
}: Props) {
  const router = useRouter();

  // Client-side (in-place) filters — no server round-trip.
  const [typeFilter, setTypeFilter] = useState('All');
  // Multi-project filter (empty = all) — shared picker with the BNL/Returns.
  // (The old "Search projects" text input was dropped when this arrived —
  // the picker's own search covers find-by-name, and a selection persists.)
  // Totals, the KPI math, and the CSV all derive from `filtered`, so picking
  // a handful of projects turns the tfoot into a portfolio rollup.
  const [selProjects, setSelProjects] = useState<number[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('ph_exit_rate');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [extraCols, setExtraCols] = useState<string[]>([]);
  // ⚙ Columns menu anchor — FIXED popover like every other picker. The old
  // absolute-in-panel version was clipped by the panel, so a short table
  // (e.g. 2 selected projects) cut the list off (user report 2026-08-12).
  const [colMenu, setColMenu] = useState<{ x: number; y: number } | null>(null);

  // ── Client drill-down ──────────────────────────────────────────────────────
  // Opens the hashed PersonalIDs behind one cell. RLS (`scoped read drill`)
  // decides what comes back, so an agency user hitting another agency's project
  // just gets an empty list.
  const [drill, setDrill] = useState<
    { project: string; projectId: number; column: string; label: string; expected: number } | null
  >(null);
  const [drillIds, setDrillIds] = useState<string[] | null>(null);
  const [drillErr, setDrillErr] = useState<string | null>(null);

  /** Project detail panel — the equivalent of openProjPanel() on the static page. */
  const [panelProject, setPanelProject] = useState<number | null>(null);

  // drill_clients holds only monthly periods, at the aggregate household/subpop.
  // On any other view the stored row does not exist, so show plain numbers rather
  // than a drill link that opens to an empty list.
  const canDrill = granularity === 'monthly' && household === 'All' && subpopulation === 'All';

  async function openDrill(r: ProjectMetric, column: string, label: string, expected: number) {
    setDrill({ project: r.project_name ?? String(r.project_id), projectId: r.project_id, column, label, expected });
    setDrillIds(null);
    setDrillErr(null);
    try {
      const qs = new URLSearchParams({
        period, project_id: String(r.project_id), metric: column,
      });
      const res = await fetch(`/api/drill?${qs}`, { credentials: 'same-origin' });
      const j = await res.json();
      if (!res.ok) { setDrillErr(j.error ?? 'Could not load clients.'); setDrillIds([]); }
      else setDrillIds(j.ids as string[]);
    } catch {
      setDrillErr('Could not load clients.');
      setDrillIds([]);
    }
  }

  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.type_name && s.add(r.type_name));
    return ['All', ...Array.from(s).sort()];
  }, [rows]);

  // Options for the multi-project picker — every row this viewer can see in
  // the current period (deliberately NOT gated by activeOnly/type, so a
  // selection survives toggling the other filters).
  const projectOpts = useMemo(() =>
    rows.map((r) => ({ id: r.project_id, name: r.project_name ?? String(r.project_id), type: r.type_name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (selProjects.length && !selProjects.includes(r.project_id)) return false;
      if (typeFilter !== 'All' && r.type_name !== typeFilter) return false;
      if (activeOnly && !(r.clients_served && r.clients_served > 0)) return false;
      return true;
    });
  }, [rows, selProjects, typeFilter, activeOnly]);

  const sorted = useMemo(() => {
    const val = (r: ProjectMetric): number | string | null => {
      if (sortKey === 'name') return r.project_name || '';
      if (sortKey === 'type_name') return r.type_name || '';
      if (sortKey === 'mom') return mom(r);
      if (['clients_served', 'leavers', 'exits_ph', 'ph_exit_rate', 'exits_unsub', 'unsub_rate', 'avg_los'].includes(sortKey))
        return (r as any)[sortKey];
      const v = r.data?.[sortKey];
      return typeof v === 'number' ? v : null;
    };
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === 'string' || typeof y === 'string')
        return String(x).localeCompare(String(y)) * sortDir;
      const xn = x == null ? -Infinity : x;
      const yn = y == null ? -Infinity : y;
      return (xn - yn) * sortDir;
    });
  }, [filtered, sortKey, sortDir]);

  // Totals (rates are recomputed from summed numerators/denominators, not averaged).
  const totals = useMemo(() => {
    let clients = 0, leavers = 0, exitsPh = 0, exitsUnsub = 0;
    // Rollup conventions: rates = ratio of sums over PHRateDenom (APR
    // Appendix-A Row 40 − Row 42 — the exact denominator behind every
    // per-row rate; rows loaded before the ETL shipped it fall back to raw
    // leavers). Avg LOS = client-weighted mean. Pos Rate sums SO rows only
    // (the pipeline emits null for every other type). Earned Inc % gets NO
    // total: its denominator (clients with income data) isn't stored, and
    // a client-weighted guess would be wrong.
    let phDen = 0, losWt = 0, losClients = 0, posExits = 0, posDen = 0, hasPos = false;
    const extraSum: Record<string, number> = {};
    filtered.forEach((r) => {
      clients += r.clients_served || 0;
      leavers += r.leavers || 0;
      exitsPh += r.exits_ph || 0;
      exitsUnsub += r.exits_unsub || 0;
      const dRaw = r.data?.['PHRateDenom'];
      const den = typeof dRaw === 'number' ? dRaw : (r.leavers || 0);
      phDen += den;
      if (r.avg_los != null && r.clients_served) {
        losWt += r.avg_los * r.clients_served; losClients += r.clients_served;
      }
      if (typeof r.data?.['ExitsToPosOutreach'] === 'number') {
        hasPos = true;
        posExits += r.data['ExitsToPosOutreach'] as number;
        posDen += den;
      }
      for (const c of EXTRA_COLUMNS) {
        if (c.pct) continue;
        const v = r.data?.[c.key];
        if (typeof v === 'number') extraSum[c.key] = (extraSum[c.key] ?? 0) + v;
      }
    });
    return {
      clients, leavers, exitsPh, exitsUnsub, extraSum,
      phRate: phDen ? (exitsPh / phDen) * 100 : null,
      unsubRate: phDen ? (exitsUnsub / phDen) * 100 : null,
      avgLos: losClients ? losWt / losClients : null,
      posRate: hasPos && posDen ? (posExits / posDen) * 100 : null,
    };
  }, [filtered]);

  function navigate(patch: Partial<{ g: string; p: string; hh: string; sub: string }>) {
    const sp = new URLSearchParams();
    sp.set('g', patch.g ?? granularity);
    // changing granularity invalidates the period — let the server pick the latest
    if (!('g' in patch) || patch.g === granularity) sp.set('p', patch.p ?? period);
    sp.set('hh', patch.hh ?? household);
    sp.set('sub', patch.sub ?? subpopulation);
    router.push(`/dashboard?${sp.toString()}`);
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'type_name' ? 1 : -1);
    }
  }

  function exportCsv() {
    const headers = ['Project', 'Type', 'Clients', 'Leavers', 'ExitsToPH', 'PHExitRate', `${POP_LABEL[granularity] ?? 'MoM'}_pp`, 'ExitsToUnsub', 'UnsubRate', 'AvgLOS',
      ...extraCols];
    const lines = [headers.join(',')];
    sorted.forEach((r) => {
      const base = [
        csv(r.project_name), r.type_name ?? '', r.clients_served ?? '', r.leavers ?? '',
        r.exits_ph ?? '', r.ph_exit_rate ?? '', mom(r) ?? '', r.exits_unsub ?? '', r.unsub_rate ?? '', r.avg_los ?? '',
        ...extraCols.map((k) => r.data?.[k] ?? ''),
      ];
      lines.push(base.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `project_performance_${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sortCar = (key: SortKey) => (
    <span className="car">{sortKey === key ? (sortDir < 0 ? '▼' : '▲') : '▼'}</span>
  );
  const thCls = (key: SortKey, num = false) =>
    `sortable${num ? ' num' : ''}${sortKey === key ? ' sorted' : ''}`;

  /* Delta lines show just "▲ 2.3pp" — the MoM/QoQ/YoY tag lives in this
     tooltip (and the PH Rate header) to keep the rate columns narrow. */
  const deltaTitle = `${POP_LABEL[granularity] ?? 'MoM'} — vs prior ${
    granularity === 'quarterly' ? 'quarter' : granularity === 'fiscal' ? 'fiscal year' : 'month'}`;

  return (
    <>
      {/* ── Filter bar (View by / period / household / subpop drive the server query) ──
          perf-wide widens THIS tab's .wrap to 1520px (extra-columns headroom) */}
      <div className="fbar perf-wide">
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
              {periods.map((p) => (
                <option key={p} value={p}>{periodLabel(p)}</option>
              ))}
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
            <span className="flabel">Projects</span>
            <ProjectPicker options={projectOpts} selected={selProjects}
              onChange={setSelProjects}
              title="Filter the table to one or more projects — totals become the selection's rollup" />
          </div>
          <div className={`switch${activeOnly ? '' : ' off'}`} onClick={() => setActiveOnly((v) => !v)}>
            <span className="tk" />Active only
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Project Performance</h3>
            <div className="meta">
              {fmtInt(sorted.length)} projects · {periodLabel(period)}
              {period === partialPeriod && <span className="pill warn" style={{ marginLeft: 8 }}>partial period</span>}
              {' · click a column to sort'}
              {canDrill
                ? ' · click an underlined count (🔍) to list its clients'
                : ' · switch to the monthly, all-households view to list clients behind a count'}
            </div>
          </div>
          <div className="tools">
            <button className="tbtn" onClick={exportCsv}>⬇ CSV</button>
            <div className="colpick">
              <button className="tbtn" onClick={(e) => {
                if (colMenu) { setColMenu(null); return; }
                const rect = e.currentTarget.getBoundingClientRect();
                setColMenu({ x: rect.right, y: rect.bottom });
              }}>⚙ Columns</button>
              {colMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={() => setColMenu(null)} />
                  <div className="colmenu" style={{
                    position: 'fixed', right: 'auto',
                    left: Math.max(8, Math.min(colMenu.x - 240, window.innerWidth - 248)),
                    top: Math.min(colMenu.y + 6, Math.max(window.innerHeight - 360, 8)),
                  }}>
                    {EXTRA_COLUMNS.map((c) => (
                      <label key={c.key}>
                        <input
                          type="checkbox"
                          checked={extraCols.includes(c.key)}
                          onChange={(e) =>
                            setExtraCols((prev) =>
                              e.target.checked ? [...prev, c.key] : prev.filter((k) => k !== c.key),
                            )
                          }
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="scroll">
          <table className="perf-table">
            <thead>
              <tr>
                <th className={thCls('name')} onClick={() => toggleSort('name')}>Project {sortCar('name')}</th>
                <th className={thCls('type_name')} onClick={() => toggleSort('type_name')}>Type {sortCar('type_name')}</th>
                <th className={thCls('clients_served', true)} onClick={() => toggleSort('clients_served')}>Clients {sortCar('clients_served')}</th>
                <th className={thCls('leavers', true)} onClick={() => toggleSort('leavers')}>Leavers {sortCar('leavers')}</th>
                <th className={thCls('exits_ph', true)} onClick={() => toggleSort('exits_ph')}>→ PH {sortCar('exits_ph')}</th>
                <th className={thCls('ph_exit_rate', true)} onClick={() => toggleSort('ph_exit_rate')}
                  title={`Period-over-period change (${POP_LABEL[granularity] ?? 'MoM'}) shown under each rate`}>PH Rate {sortCar('ph_exit_rate')}</th>
                <th className={thCls('exits_unsub', true)} onClick={() => toggleSort('exits_unsub')}
                  title="Exits to unsubsidized permanent housing (own lease, destinations 410/411) — the count behind Unsub %">Unsub {sortCar('exits_unsub')}</th>
                <th className={thCls('unsub_rate', true)} onClick={() => toggleSort('unsub_rate')}
                  title="Unsubsidized rate — share of PH exits going to own lease (410/411)">Unsub % {sortCar('unsub_rate')}</th>
                <th className={thCls('avg_los', true)} onClick={() => toggleSort('avg_los')}>Avg LOS {sortCar('avg_los')}</th>
                {extraCols.map((k) => {
                  const c = EXTRA_COLUMNS.find((x) => x.key === k)!;
                  return (
                    <th key={k} className={`${thCls(k, true)} xcol`} onClick={() => toggleSort(k)}>{c.label} {sortCar(k)}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const phr = r.ph_exit_rate;
                const m = mom(r);
                // Target-aware coloring (user directive 2026-08-13): a metric
                // WITH a resolved target colors green/red against IT; only
                // untargeted metrics use the fixed system-wide bands. tEval
                // is empty on filtered household/subpop views → bands there.
                const tf = targetFlags[r.project_id];
                const tEval = (k: string) => tf?.find((e) => e.key === k);
                const misses = (tf ?? []).filter((e) => !e.met);
                const phT = tEval('ph_exit_rate');
                const band = phT ? (phT.met ? 'good' : 'bad') : rateBand(phr);
                const tTip = (t: TargetMiss | undefined) => t
                  ? `${t.met ? 'meets' : 'misses'} target ${t.higherBetter ? '≥' : '≤'} ${fmtTarget(t.target, t.unit)}`
                  : undefined;
                return (
                  <tr key={r.project_id}>
                    <td>
                      <span className="pnm">
                        <span className="rank">{i + 1}</span>
                        <span className="nm pp-link" role="button" tabIndex={0}
                          title="Open project detail"
                          onClick={() => setPanelProject(r.project_id)}
                          onKeyDown={(e) => e.key === 'Enter' && setPanelProject(r.project_id)}>
                          {r.project_name}
                        </span>
                        {misses.length > 0 && (
                          <span className="tflag"
                            title={misses
                              .map((x) => `${x.label}: ${fmtTarget(x.current, x.unit)} vs target ${x.higherBetter ? '≥' : '≤'} ${fmtTarget(x.target, x.unit)}`)
                              .join(' · ')}>
                            ⚑ off target
                          </span>
                        )}
                      </span>
                    </td>
                    <td><span className="ty">{r.type_name}</span></td>
                    <td className="num">
                      {canDrill && r.clients_served ? (
                        <span className="drill" role="button" tabIndex={0}
                          title="Show the clients behind this number"
                          onClick={() => openDrill(r, 'clients_served', 'Clients served', r.clients_served!)}
                          onKeyDown={(e) => e.key === 'Enter' && openDrill(r, 'clients_served', 'Clients served', r.clients_served!)}>
                          {fmtInt(r.clients_served)}
                        </span>
                      ) : fmtInt(r.clients_served)}
                    </td>
                    <td className="num">
                      {canDrill && r.leavers ? (
                        <span className="drill" role="button" tabIndex={0}
                          title="Show the clients behind this number"
                          onClick={() => openDrill(r, 'leavers', 'Leavers (exited)', r.leavers!)}
                          onKeyDown={(e) => e.key === 'Enter' && openDrill(r, 'leavers', 'Leavers (exited)', r.leavers!)}>
                          {fmtInt(r.leavers)}
                        </span>
                      ) : fmtInt(r.leavers)}
                    </td>
                    <td className="num">
                      {canDrill && r.exits_ph ? (
                        <span className="drill" role="button" tabIndex={0}
                          title="Show the clients behind this number"
                          onClick={() => openDrill(r, 'exits_ph', 'Exits to permanent housing', r.exits_ph!)}
                          onKeyDown={(e) => e.key === 'Enter' && openDrill(r, 'exits_ph', 'Exits to permanent housing', r.exits_ph!)}>
                          {fmtInt(r.exits_ph)}
                        </span>
                      ) : fmtInt(r.exits_ph)}
                    </td>
                    {/* Rate + P-o-P delta live in ONE cell (user pick 2026-08-13:
                        vertical fill pill, delta stacked under — no Δ column). */}
                    <td className="num">
                      {phr == null ? '—' : (
                        <>
                          <span className="rbar">
                            <span className="vpil"><i style={{ height: `${Math.min(100, phr)}%`, background: bandColorVar(band) }} /></span>
                            <span className={`pill ${band}`} title={tTip(phT)}>{phr.toFixed(0)}%</span>
                          </span>
                          {m != null && (
                            <div className={`rdel ${m > 0 ? 'up' : m < 0 ? 'down' : 'flat'}`} title={deltaTitle}>
                              {m > 0 ? `▲ ${m.toFixed(1)}pp` : m < 0 ? `▼ ${Math.abs(m).toFixed(1)}pp` : '±0'}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="num">
                      {canDrill && r.exits_unsub ? (
                        <span className="drill" role="button" tabIndex={0}
                          title="Show the clients behind this number"
                          onClick={() => openDrill(r, 'exits_unsub', 'Exits to unsubsidized housing', r.exits_unsub!)}
                          onKeyDown={(e) => e.key === 'Enter' && openDrill(r, 'exits_unsub', 'Exits to unsubsidized housing', r.exits_unsub!)}>
                          {fmtInt(r.exits_unsub)}
                        </span>
                      ) : fmtInt(r.exits_unsub)}
                    </td>
                    <td className="num">
                      {r.unsub_rate == null ? '—' : (() => {
                        const unT = tEval('unsub_rate');
                        const cls = unT ? (unT.met ? 'good' : 'bad')
                          : r.unsub_rate! >= 20 ? 'good' : r.unsub_rate! >= 10 ? 'warn' : 'bad';
                        return <span className={`pill ${cls}`} title={tTip(unT)}>{r.unsub_rate!.toFixed(0)}%</span>;
                      })()}
                    </td>
                    <td className="num">{r.avg_los == null ? '—' : `${Math.round(r.avg_los)}d`}</td>
                    {extraCols.map((k) => {
                      const c = EXTRA_COLUMNS.find((x) => x.key === k)!;
                      const v = r.data?.[k];
                      // Pos Outreach % mirrors the PH Rate cell exactly (user
                      // pick 2026-08-13): vertical pill + stacked P-o-P delta,
                      // same 3-band coloring anchored at the SO threshold —
                      // green ≥55, amber 45–54, red <45.
                      if (k === 'PosOutreachRate' && v != null && v !== '') {
                        const n = Number(v);
                        const poT = tEval('pos_outreach_rate');
                        const pb = poT ? (poT.met ? 'good' : 'bad') : rateBand(n, 55, 45);
                        const pd = r.data?.['MoM_PosOutreachRate_pp'];
                        const pdn = typeof pd === 'number' ? pd : null;
                        return (
                          <td key={k} className="num">
                            <span className="rbar">
                              <span className="vpil"><i style={{ height: `${Math.min(100, n)}%`, background: bandColorVar(pb) }} /></span>
                              <span className={`pill ${pb}`} title={tTip(poT)}>{n.toFixed(0)}%</span>
                            </span>
                            {pdn != null && (
                              <div className={`rdel ${pdn > 0 ? 'up' : pdn < 0 ? 'down' : 'flat'}`} title={deltaTitle}>
                                {pdn > 0 ? `▲ ${pdn.toFixed(1)}pp` : pdn < 0 ? `▼ ${Math.abs(pdn).toFixed(1)}pp` : '±0'}
                              </div>
                            )}
                          </td>
                        );
                      }
                      return (
                        <td key={k} className="num">
                          {v == null || v === '' ? '—' : c.pct ? `${Number(v).toFixed(0)}%` : fmtInt(Number(v))}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={9 + extraCols.length} className="empty">No projects match these filters.</td></tr>
              )}
            </tbody>
            {sorted.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total · {fmtInt(sorted.length)} projects</td>
                  <td />
                  <td className="num">{fmtInt(totals.clients)}</td>
                  <td className="num">{fmtInt(totals.leavers)}</td>
                  <td className="num">{fmtInt(totals.exitsPh)}</td>
                  <td className="num">{totals.phRate == null ? '—' : `${totals.phRate.toFixed(0)}%`}</td>
                  <td className="num">{fmtInt(totals.exitsUnsub)}</td>
                  <td className="num">{totals.unsubRate == null ? '—' : `${totals.unsubRate.toFixed(0)}%`}</td>
                  <td className="num" title="Client-weighted average across the listed projects">
                    {totals.avgLos == null ? '—' : `${Math.round(totals.avgLos)}d`}
                  </td>
                  {extraCols.map((k) => {
                    if (k === 'PosOutreachRate') {
                      return (
                        <td key={k} className="num" title="SO projects only — positive exits / APR rate denominator">
                          {totals.posRate == null ? '—' : `${totals.posRate.toFixed(0)}%`}
                        </td>
                      );
                    }
                    const s = totals.extraSum[k];
                    return <td key={k} className="num">{s == null ? '—' : fmtInt(s)}</td>;
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {panelProject != null && (
        <ProjectPanel
          projectId={panelProject}
          granularity={granularity}
          period={period}
          household={household}
          subpopulation={subpopulation}
          onClose={() => setPanelProject(null)}
        />
      )}

      {drill && (
        <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && setDrill(null)}>
          <div className="bnl-modal">
            <button className="bnl-x" onClick={() => setDrill(null)}>✕</button>
            <h3>{drill.label}</h3>
            <div className="bnl-sub" style={{ marginTop: 2 }}>
              {drill.project} · {periodLabel(period)}
            </div>

            {drillIds === null && <div className="hc-none">Loading clients…</div>}
            {drillErr && <div className="bnl-dq" style={{ marginTop: 12 }}>{drillErr}</div>}

            {drillIds && !drillErr && (
              <>
                <div className="dr-head">
                  <span>
                    <b>{drillIds.length.toLocaleString()}</b> client{drillIds.length === 1 ? '' : 's'}
                    {drillIds.length !== drill.expected && (
                      // Mismatch is expected when RLS filtered the row (no grant on
                      // this project) — say so rather than showing a silent 0.
                      <span className="bnl-sub"> · table shows {drill.expected.toLocaleString()}</span>
                    )}
                  </span>
                  {drillIds.length > 0 && (
                    <button className="btn" onClick={(e) => {
                      navigator.clipboard?.writeText(drillIds.join('\n'));
                      const el = e.currentTarget; el.textContent = 'Copied ✓';
                      setTimeout(() => { el.textContent = '⧉ Copy IDs'; }, 1200);
                    }}>⧉ Copy IDs</button>
                  )}
                </div>

                {drillIds.length === 0 ? (
                  <div className="hc-none">
                    No clients returned. Either this metric was zero for the period, or
                    your account does not have access to this project.
                  </div>
                ) : (
                  <>
                    <div className="dr-ids">
                      {drillIds.map((id) => <CopyId key={id} pid={id} />)}
                    </div>
                    <p className="bnl-sub" style={{ marginTop: 10 }}>
                      These are hashed PersonalIDs — HMIS access is required to identify
                      individuals. Click one to copy it for HMIS client search.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const csv = (s: string | null): string => {
  const v = s ?? '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
