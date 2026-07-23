'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtInt, periodLabel } from '../../../lib/format';
import { fmtDays, type SurvivalRow } from '../../../components/TimeToHousing';

/**
 * Small-multiples performance grid — one sparkline per selected project, worst
 * first.
 *
 * Two design rules make this a grid rather than 26 unrelated charts:
 *
 *  1. SHARED Y SCALE. Every card in the grid is drawn against the same axis, so
 *     card height means the same thing everywhere and the eye can compare them
 *     without reading a single number. Per-card auto-scaling would make a project
 *     wobbling between 4% and 6% look identical to one swinging 10%–60%.
 *  2. SORTED WORST-FIRST. The whole reason to look at 26 projects at once is to
 *     find the few that need attention. Alphabetical order buries them.
 *
 * "Worst" depends on the metric, so each one declares its direction. Clients
 * served has no good or bad direction at all and is sorted by size instead —
 * labelled as such, so nobody reads the top of that grid as a problem list.
 */

interface GridRow {
  project_id: number;
  period: string;
  clients_served: number | null;
  exits_ph: number | null;
  ph_exit_rate: number | null;
  avg_los: number | null;
  unsub_rate: number | null;
  is_partial: boolean | null;
}

type SurvLite = Pick<SurvivalRow,
  'ref_id' | 'event' | 'n' | 'n_housed' | 'median_days' | 'rate_180' | 'type_median' | 'type_rate_180' | 'window_end'>;

interface GridData {
  periods: string[];
  rows: GridRow[];
  survival: SurvLite[];
  projects: { project_id: number; name: string | null; type_name: string | null }[];
}

interface Metric {
  key: keyof GridRow;
  label: string;
  unit: string;
  /** null = no good direction; sort by magnitude and say so. */
  higherBetter: boolean | null;
  /** Rates share a fixed 0–100 axis; counts scale to the selection. */
  fixedMax?: number;
}

const METRICS: Metric[] = [
  { key: 'ph_exit_rate', label: 'PH exit rate', unit: '%', higherBetter: true, fixedMax: 100 },
  { key: 'unsub_rate', label: 'Unsubsidised exit rate', unit: '%', higherBetter: true, fixedMax: 100 },
  { key: 'avg_los', label: 'Average length of stay', unit: 'd', higherBetter: false },
  { key: 'clients_served', label: 'Clients served', unit: '', higherBetter: null },
];

const fmtVal = (v: number | null, unit: string): string => {
  if (v == null) return '—';
  if (unit === '%') return `${Number(v.toFixed(1))}%`;
  if (unit === 'd') return `${Number(v.toFixed(1))}d`;
  return fmtInt(v);
};

/** Sparkline over the shared window. Gaps where a period has no value — a
 *  straight line across a gap would invent months that were never reported. */
function Spark({
  series, max, current, highlightLast,
}: { series: (number | null)[]; max: number; current: number | null; highlightLast: boolean }) {
  const W = 240, H = 56, P = 3;
  const n = series.length;
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(n - 1, 1);
  const y = (v: number) => H - P - ((H - 2 * P) * Math.max(0, Math.min(v, max))) / (max || 1);

  // Split into runs of consecutive non-null points so gaps stay gaps.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  series.forEach((v, i) => {
    if (v == null) { if (run.length) runs.push(run); run = []; }
    else run.push({ i, v });
  });
  if (run.length) runs.push(run);

  const lastIdx = series.reduce<number>((acc, v, i) => (v != null ? i : acc), -1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pg-spark" preserveAspectRatio="none" aria-hidden="true">
      {runs.map((r, k) => (
        <path key={k} fill="none" stroke="var(--primary)" strokeWidth={1.8} strokeLinejoin="round"
          d={r.map((p, i) => `${i ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')} />
      ))}
      {lastIdx >= 0 && current != null && (
        // The final month is usually the partial one — drawn hollow so a
        // half-reported month is never mistaken for a real drop.
        <circle cx={x(lastIdx)} cy={y(current)} r={3.2}
          fill={highlightLast ? 'var(--card)' : 'var(--primary)'}
          stroke="var(--primary)" strokeWidth={1.6} />
      )}
    </svg>
  );
}

export default function PerformanceGrid({
  projectIds, options,
}: { projectIds: number[]; options: { id: number; name: string; type: string }[] }) {
  const [data, setData] = useState<GridData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [metricKey, setMetricKey] = useState<string>('ph_exit_rate');
  const [open, setOpen] = useState(true);

  const metric = METRICS.find((m) => m.key === metricKey)!;

  useEffect(() => {
    if (!open || !projectIds.length) { return; }
    let live = true;
    setLoading(true); setErr(null);
    fetch(`/api/grid?projects=${projectIds.join(',')}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setData(j); })
      .catch(() => { if (live) setErr('Could not load the performance grid.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectIds, open]);

  const nameOf = useMemo(() => {
    const m = new Map<number, { name: string; type: string }>();
    options.forEach((o) => m.set(o.id, { name: o.name, type: o.type }));
    (data?.projects ?? []).forEach((p) =>
      m.set(Number(p.project_id), { name: p.name ?? `Project ${p.project_id}`, type: p.type_name ?? '' }));
    return m;
  }, [options, data]);

  const survOf = useMemo(() => {
    const m = new Map<number, SurvLite>();
    (data?.survival ?? []).forEach((s) => m.set(Number(s.ref_id), s));
    return m;
  }, [data]);

  const cards = useMemo(() => {
    if (!data) return [];
    const byProject = new Map<number, Map<string, GridRow>>();
    for (const r of data.rows) {
      const id = Number(r.project_id);
      if (!byProject.has(id)) byProject.set(id, new Map());
      byProject.get(id)!.set(r.period, r);
    }

    const built = projectIds.map((id) => {
      const rows = byProject.get(id);
      const series = data.periods.map((p) => {
        const v = rows?.get(p)?.[metric.key];
        return typeof v === 'number' ? v : null;
      });
      const lastIdx = series.reduce<number>((acc, v, i) => (v != null ? i : acc), -1);
      const current = lastIdx >= 0 ? series[lastIdx] : null;
      const partial = lastIdx >= 0 ? !!rows?.get(data.periods[lastIdx])?.is_partial : false;

      // Compare against the mean of the preceding periods, not the single month
      // before — one quiet month would otherwise read as a trend.
      const prior = series.slice(0, Math.max(lastIdx, 0)).filter((v): v is number => v != null);
      const baseline = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
      const delta = current != null && baseline != null ? current - baseline : null;

      const info = nameOf.get(id);
      return {
        id,
        name: info?.name ?? `Project ${id}`,
        type: info?.type ?? '',
        series, current, delta, partial,
        surv: survOf.get(id) ?? null,
        n: rows?.size ?? 0,
      };
    });

    // Worst first. Projects with no data at all sink to the bottom — an empty
    // card at the top would read as the worst performer when it is just silent.
    const dir = metric.higherBetter;
    return built.sort((a, b) => {
      if (a.current == null && b.current == null) return a.name.localeCompare(b.name);
      if (a.current == null) return 1;
      if (b.current == null) return -1;
      if (dir === true) return a.current - b.current;      // low rate = worst
      return b.current - a.current;                        // high LOS = worst; size desc for counts
    });
  }, [data, projectIds, metric, nameOf, survOf]);

  // One axis for the whole grid — see the header comment.
  const max = useMemo(() => {
    if (metric.fixedMax) return metric.fixedMax;
    const vals = cards.flatMap((c) => c.series.filter((v): v is number => v != null));
    return vals.length ? Math.max(...vals) : 1;
  }, [cards, metric]);

  const withData = cards.filter((c) => c.current != null).length;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h dd-head" role="button" tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}>
        <div>
          <h3>Performance grid <span className="bnl-sub">({projectIds.length} project{projectIds.length === 1 ? '' : 's'})</span></h3>
          <div className="meta">
            One sparkline per project over the last {data?.periods.length ?? 24} months,
            all drawn on the same scale and sorted{' '}
            {metric.higherBetter === null
              ? 'largest first — clients served has no good or bad direction'
              : 'worst first'}. The hollow point marks a partial month.
          </div>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {open && (
            <select className="fselect" value={metricKey} onClick={(e) => e.stopPropagation()}
              onChange={(e) => setMetricKey(e.target.value)}>
              {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          )}
          <span className="dd-caret">{open ? '▾' : '▸'}</span>
        </span>
      </div>

      {open && (
        <>
          {err && <div className="bnl-dq">{err}</div>}
          {loading && !data && <div className="hc-none">Loading performance grid…</div>}

          {data && (
            <>
              <div className="bnl-cnote" style={{ marginTop: 0 }}>
                {periodLabel(data.periods[0])} – {periodLabel(data.periods[data.periods.length - 1])}
                {' · '}scale 0–{fmtVal(max, metric.unit)}
                {withData < cards.length && (
                  <span className="bnl-sub"> · {cards.length - withData} project
                    {cards.length - withData === 1 ? '' : 's'} reported nothing in this window</span>
                )}
              </div>

              <div className="pg-grid">
                {cards.map((c) => {
                  const good = metric.higherBetter == null || c.delta == null
                    ? null
                    : metric.higherBetter ? c.delta > 0 : c.delta < 0;
                  return (
                    <div className="pg-card" key={c.id}>
                      <div className="pg-nm" title={c.type ? `${c.name} · ${c.type}` : c.name}>
                        {c.name}
                      </div>
                      {c.type && <div className="ty pg-ty">{c.type}</div>}

                      <div className="pg-val">
                        <b>{fmtVal(c.current, metric.unit)}</b>
                        {c.partial && <span className="pg-part" title="Latest month is partial">partial</span>}
                        {c.delta != null && (
                          <span className={`pg-d ${good === true ? 'up' : good === false ? 'down' : 'flat'}`}
                            title={`vs the average of the earlier months in this window`}>
                            {c.delta > 0 ? '▲' : c.delta < 0 ? '▼' : '■'}{' '}
                            {fmtVal(Math.abs(c.delta), metric.unit)}
                          </span>
                        )}
                      </div>

                      <Spark series={c.series} max={max} current={c.current} highlightLast={c.partial} />

                      <div className="pg-tth">
                        {c.surv
                          ? <>Median to housing <b>{fmtDays(c.surv.median_days)}</b>
                              {c.surv.type_median != null && (
                                <span className="bnl-sub"> · peers {fmtDays(c.surv.type_median)}</span>
                              )}</>
                          : <span className="bnl-sub">Too few recent entries for a time-to-housing figure</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="bnl-method">
                Values are the stored monthly figures from the Project Performance tab —
                nothing is recalculated here. The change figure compares the latest month
                against the average of the earlier months in the window, so a single quiet
                month does not read as a trend. Median time to housing comes from the
                Kaplan-Meier cohort{data.survival[0]?.window_end ? ` ending ${data.survival[0].window_end}` : ''};
                open a project on the Project Performance tab for its full curve.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
