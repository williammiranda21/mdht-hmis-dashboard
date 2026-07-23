'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Granularity, ProjectMetric } from '../../lib/types';
import { HOUSEHOLD_OPTIONS, SUBPOPULATION_OPTIONS } from '../../lib/types';
import { periodLabel, rateBand, bandColorVar, fmtInt } from '../../lib/format';
import ProjectPanel from './ProjectPanel';

type Props = {
  rows: ProjectMetric[];
  periods: string[];
  granularity: Granularity;
  period: string;
  household: string;
  subpopulation: string;
};

// Extra columns available through the ⚙ Columns picker — pulled from the full jsonb record.
const EXTRA_COLUMNS: { key: string; label: string; pct?: boolean }[] = [
  { key: 'ExitsToPosOutreach', label: '→ Pos Outreach' },
  { key: 'PosOutreachRate', label: 'Pos Outreach %', pct: true },
  { key: 'SOContacts', label: 'SO Contacts' },
  { key: 'SOEngagements', label: 'SO Engagements' },
  { key: 'EarnedIncomeImprovementRate', label: 'Earned Inc Impr %', pct: true },
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

const mom = (r: ProjectMetric): number | null => {
  const v = r.data?.['MoM_PHExitRate_pp'];
  return typeof v === 'number' ? v : null;
};

export default function DashboardView({
  rows, periods, granularity, period, household, subpopulation,
}: Props) {
  const router = useRouter();

  // Client-side (in-place) filters — no server round-trip.
  const [typeFilter, setTypeFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('ph_exit_rate');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [extraCols, setExtraCols] = useState<string[]>([]);
  const [colMenuOpen, setColMenuOpen] = useState(false);

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

  async function openDrill(r: ProjectMetric, column: string, label: string, expected: number) {
    setDrill({ project: r.project_name ?? String(r.project_id), projectId: r.project_id, column, label, expected });
    setDrillIds(null);
    setDrillErr(null);
    try {
      const qs = new URLSearchParams({
        period, project_id: String(r.project_id), metric: column,
      });
      const res = await fetch(`/api/drill?${qs}`);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter !== 'All' && r.type_name !== typeFilter) return false;
      if (activeOnly && !(r.clients_served && r.clients_served > 0)) return false;
      if (q && !(r.project_name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, typeFilter, activeOnly, query]);

  const sorted = useMemo(() => {
    const val = (r: ProjectMetric): number | string | null => {
      if (sortKey === 'name') return r.project_name || '';
      if (sortKey === 'type_name') return r.type_name || '';
      if (sortKey === 'mom') return mom(r);
      if (['clients_served', 'leavers', 'exits_ph', 'ph_exit_rate', 'unsub_rate', 'avg_los'].includes(sortKey))
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
    filtered.forEach((r) => {
      clients += r.clients_served || 0;
      leavers += r.leavers || 0;
      exitsPh += r.exits_ph || 0;
      exitsUnsub += r.exits_unsub || 0;
    });
    return {
      clients, leavers, exitsPh, exitsUnsub,
      phRate: leavers ? (exitsPh / leavers) * 100 : null,
      unsubRate: leavers ? (exitsUnsub / leavers) * 100 : null,
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
    const headers = ['Project', 'Type', 'Clients', 'Leavers', 'ExitsToPH', 'PHExitRate', 'MoM_pp', 'UnsubRate', 'AvgLOS',
      ...extraCols];
    const lines = [headers.join(',')];
    sorted.forEach((r) => {
      const base = [
        csv(r.project_name), r.type_name ?? '', r.clients_served ?? '', r.leavers ?? '',
        r.exits_ph ?? '', r.ph_exit_rate ?? '', mom(r) ?? '', r.unsub_rate ?? '', r.avg_los ?? '',
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

  return (
    <>
      {/* ── Filter bar (View by / period / household / subpop drive the server query) ── */}
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
            <span className="flabel">Search projects</span>
            <input className="finput" placeholder="Filter by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
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
              {rows.some((r) => r.is_partial) && <span className="pill warn" style={{ marginLeft: 8 }}>partial period</span>}
              {' · click a column to sort'}
            </div>
          </div>
          <div className="tools">
            <button className="tbtn" onClick={exportCsv}>⬇ CSV</button>
            <div className="colpick">
              <button className="tbtn" onClick={() => setColMenuOpen((v) => !v)}>⚙ Columns</button>
              {colMenuOpen && (
                <div className="colmenu" onMouseLeave={() => setColMenuOpen(false)}>
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
              )}
            </div>
          </div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th className={thCls('name')} onClick={() => toggleSort('name')}>Project {sortCar('name')}</th>
                <th className={thCls('type_name')} onClick={() => toggleSort('type_name')}>Type {sortCar('type_name')}</th>
                <th className={thCls('clients_served', true)} onClick={() => toggleSort('clients_served')}>Clients {sortCar('clients_served')}</th>
                <th className={thCls('leavers', true)} onClick={() => toggleSort('leavers')}>Leavers {sortCar('leavers')}</th>
                <th className={thCls('exits_ph', true)} onClick={() => toggleSort('exits_ph')}>→ PH {sortCar('exits_ph')}</th>
                <th className={thCls('ph_exit_rate', true)} onClick={() => toggleSort('ph_exit_rate')}>PH Rate {sortCar('ph_exit_rate')}</th>
                <th className={thCls('mom', true)} onClick={() => toggleSort('mom')}>MoM Δ {sortCar('mom')}</th>
                <th className={thCls('unsub_rate', true)} onClick={() => toggleSort('unsub_rate')}>Unsub Rate {sortCar('unsub_rate')}</th>
                <th className={thCls('avg_los', true)} onClick={() => toggleSort('avg_los')}>Avg LOS {sortCar('avg_los')}</th>
                {extraCols.map((k) => {
                  const c = EXTRA_COLUMNS.find((x) => x.key === k)!;
                  return (
                    <th key={k} className={thCls(k, true)} onClick={() => toggleSort(k)}>{c.label} {sortCar(k)}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const phr = r.ph_exit_rate;
                const band = rateBand(phr);
                const m = mom(r);
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
                      </span>
                    </td>
                    <td><span className="ty">{r.type_name}</span></td>
                    <td className="num">
                      {r.clients_served ? (
                        <span className="drill" role="button" tabIndex={0}
                          title="Show the clients behind this number"
                          onClick={() => openDrill(r, 'clients_served', 'Clients served', r.clients_served!)}
                          onKeyDown={(e) => e.key === 'Enter' && openDrill(r, 'clients_served', 'Clients served', r.clients_served!)}>
                          {fmtInt(r.clients_served)}
                        </span>
                      ) : fmtInt(r.clients_served)}
                    </td>
                    <td className="num">{fmtInt(r.leavers)}</td>
                    <td className="num">
                      {r.exits_ph ? (
                        <span className="drill" role="button" tabIndex={0}
                          title="Show the clients behind this number"
                          onClick={() => openDrill(r, 'exits_ph', 'Exits to permanent housing', r.exits_ph!)}
                          onKeyDown={(e) => e.key === 'Enter' && openDrill(r, 'exits_ph', 'Exits to permanent housing', r.exits_ph!)}>
                          {fmtInt(r.exits_ph)}
                        </span>
                      ) : fmtInt(r.exits_ph)}
                    </td>
                    <td className="num">
                      {phr == null ? '—' : (
                        <span className="rbar">
                          <span className="rmb"><i style={{ width: `${Math.min(100, phr)}%`, background: bandColorVar(band) }} /></span>
                          <span className={`pill ${band}`}>{phr.toFixed(0)}%</span>
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {m == null ? <span className="mom flat">—</span>
                        : m > 0 ? <span className="mom up">+{m.toFixed(1)}pp</span>
                        : m < 0 ? <span className="mom down">{m.toFixed(1)}pp</span>
                        : <span className="mom flat">—</span>}
                    </td>
                    <td className="num">
                      {r.unsub_rate == null ? '—'
                        : <span className={`pill ${r.unsub_rate >= 20 ? 'good' : r.unsub_rate >= 10 ? 'warn' : 'bad'}`}>{r.unsub_rate.toFixed(0)}%</span>}
                    </td>
                    <td className="num">{r.avg_los == null ? '—' : `${Math.round(r.avg_los)}d`}</td>
                    {extraCols.map((k) => {
                      const c = EXTRA_COLUMNS.find((x) => x.key === k)!;
                      const v = r.data?.[k];
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
                  <td />
                  <td className="num">{totals.unsubRate == null ? '—' : `${totals.unsubRate.toFixed(0)}%`}</td>
                  <td />
                  {extraCols.map((k) => <td key={k} />)}
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
                      {drillIds.map((id) => <code key={id}>{id}</code>)}
                    </div>
                    <p className="bnl-sub" style={{ marginTop: 10 }}>
                      These are hashed PersonalIDs — HMIS access is required to identify
                      individuals. Paste one into HMIS client search to look it up.
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
