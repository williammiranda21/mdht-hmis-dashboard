'use client';

import { useMemo, useState } from 'react';
import { fmtInt, periodLabel } from '../../../lib/format';
import type { SystemForecast } from '../../../lib/queries';

/**
 * Forecast — inflow projection + capacity outlook. Renders `system_forecast`;
 * nothing is computed here. Two forecast series are shown because the pipeline
 * produces both and they disagree on purpose: the weighted-average forecast
 * tracks the recent level, the linear-trend forecast tracks direction. Showing
 * one and hiding the other would imply a false precision — the honest read is
 * "somewhere between these two, and here's why they differ".
 */

interface Inflow {
  months: string[];
  total: number[];
  future_months: string[];
  wt_forecasts: number[];
  trend_forecasts: number[];
  slope_per_month: number;
  by_state: Record<string, Record<string, number>>;
}

interface CapState {
  state: string; label: string; color: string;
  beds: number; current: number; occ_now: number;
  proj_30: number; proj_60: number; proj_90: number;
  entries_mo: number; exits_mo: number; net_mo: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export default function ForecastView({ forecast }: { forecast: SystemForecast }) {
  const inflow = forecast.inflow as unknown as Inflow | null;
  const capacity = (forecast.capacity as unknown as CapState[] | null) ?? [];

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Forecast</h3>
            <div className="meta">
              System-wide inflow projection and capacity outlook
              {forecast.generated ? ` · data through ${forecast.generated}` : ''}. These are
              CoC-level figures, not agency-scoped.
            </div>
          </div>
        </div>
        <p className="bnl-method" style={{ marginTop: 0 }}>
          Projections are <b>not promises</b>. Inflow shows two model runs — a recent-level
          weighted average and a linear trend — precisely because they disagree; the future
          most likely sits between them. Read the gap between the two lines as the uncertainty,
          not the midpoint as a target.
        </p>
      </div>

      {inflow && <InflowPanel inflow={inflow} />}
      {capacity.length > 0 && <CapacityPanel capacity={capacity} />}
    </>
  );
}

/* ── Inflow ───────────────────────────────────────────────────────────────── */
function InflowPanel({ inflow }: { inflow: Inflow }) {
  const STATES = useMemo(
    () => Object.keys(inflow.by_state ?? {}),
    [inflow.by_state],
  );
  const [stateKey, setStateKey] = useState<string>('__all');

  // History series — either the system total, or one state's monthly inflow.
  const hist = useMemo(() => {
    if (stateKey === '__all') {
      return inflow.months.map((m, i) => ({ m, v: inflow.total[i] ?? null }));
    }
    const bs = inflow.by_state[stateKey] ?? {};
    return inflow.months.map((m) => ({ m, v: num(bs[m]) }));
  }, [inflow, stateKey]);

  // Forecast series only exist for the system total — the by-state payload has no
  // projection, so switching to a state hides the forecast lines rather than
  // faking them.
  const showForecast = stateKey === '__all';
  const recentAvg = useMemo(() => {
    const last = inflow.total.slice(-12).filter((v) => typeof v === 'number');
    return last.length ? Math.round(last.reduce((a, b) => a + b, 0) / last.length) : null;
  }, [inflow.total]);

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h dd-head">
        <div>
          <h3>Monthly inflow</h3>
          <div className="meta">
            New people entering the system each month (system-unduplicated), with the
            next {inflow.future_months.length} months projected.
          </div>
        </div>
        <select className="fselect" value={stateKey} onChange={(e) => setStateKey(e.target.value)}>
          <option value="__all">All programme types</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="hc-tiles dd-pad" style={{ marginTop: 4 }}>
        <div className="hc-t">
          <div className="k">Recent monthly inflow</div>
          <div className="v">{recentAvg != null ? fmtInt(recentAvg) : '—'}</div>
          <div className="s">12-month average</div>
        </div>
        {showForecast && (
          <>
            <div className="hc-t">
              <div className="k">Next 3 months (weighted)</div>
              <div className="v">{fmtInt(Math.round(avg(inflow.wt_forecasts)))}/mo</div>
              <div className="s">tracks the recent level</div>
            </div>
            <div className="hc-t">
              <div className="k">Next 3 months (trend)</div>
              <div className="v">{fmtInt(Math.round(avg(inflow.trend_forecasts)))}/mo</div>
              <div className="s">
                {inflow.slope_per_month >= 0 ? '▲' : '▼'} {Math.abs(inflow.slope_per_month)}/mo slope
              </div>
            </div>
          </>
        )}
      </div>

      <div className="dd-pad">
        <InflowChart
          hist={hist}
          futureMonths={showForecast ? inflow.future_months : []}
          wt={showForecast ? inflow.wt_forecasts : []}
          trend={showForecast ? inflow.trend_forecasts : []}
        />
      </div>
    </div>
  );
}

const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function InflowChart({
  hist, futureMonths, wt, trend,
}: {
  hist: { m: string; v: number | null }[];
  futureMonths: string[]; wt: number[]; trend: number[];
}) {
  const W = 1000, H = 260, L = 44, R = 14, T = 14, B = 46;
  const allMonths = [...hist.map((h) => h.m), ...futureMonths];
  const n = allMonths.length;
  const vals = [
    ...hist.map((h) => h.v),
    ...wt, ...trend,
  ].filter((v): v is number => v != null);
  const maxV = vals.length ? Math.max(...vals) : 1;
  const yMax = Math.ceil(maxV / 100) * 100 || 100;

  const x = (i: number) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);

  const histPts = hist.map((h, i) => ({ i, v: h.v }));
  const line = (pts: { i: number; v: number | null }[]) => {
    let d = ''; let started = false;
    for (const p of pts) {
      if (p.v == null) { started = false; continue; }
      d += `${started ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)} `;
      started = true;
    }
    return d.trim();
  };

  const lastHist = [...histPts].reverse().find((p) => p.v != null);
  // Forecast lines start at the last real history point so they visibly continue it.
  const wtPts = lastHist
    ? [lastHist, ...wt.map((v, k) => ({ i: hist.length + k, v }))] : [];
  const trendPts = lastHist
    ? [lastHist, ...trend.map((v, k) => ({ i: hist.length + k, v }))] : [];

  const step = Math.max(1, Math.ceil(n / 12));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fc-chart" preserveAspectRatio="none" role="img"
      aria-label="Monthly inflow with projection">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => {
        const v = yMax * g;
        return (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={1} />
            <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{fmtInt(v)}</text>
          </g>
        );
      })}
      {/* history / forecast divider */}
      {futureMonths.length > 0 && lastHist && (
        <line x1={x(lastHist.i)} x2={x(lastHist.i)} y1={T} y2={H - B}
          stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 3" />
      )}

      <path d={line(histPts)} fill="none" stroke="var(--primary)" strokeWidth={2.4} />
      {wtPts.length > 1 && (
        <path d={line(wtPts)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />
      )}
      {trendPts.length > 1 && (
        <path d={line(trendPts)} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="6 4" />
      )}

      {allMonths.map((m, i) => (i % step === 0 || i === n - 1) && (
        <text key={m} x={x(i)} y={H - 26} textAnchor="middle" fontSize={8.5} fill="var(--muted)">
          {m.slice(2)}
        </text>
      ))}

      <g>
        <line x1={L} x2={L + 22} y1={H - 8} y2={H - 8} stroke="var(--primary)" strokeWidth={2.4} />
        <text x={L + 28} y={H - 5} fontSize={10} fill="var(--text)">actual</text>
        {wtPts.length > 1 && (
          <>
            <line x1={L + 120} x2={L + 142} y1={H - 8} y2={H - 8} stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />
            <text x={L + 148} y={H - 5} fontSize={10} fill="var(--muted)">weighted</text>
            <line x1={L + 250} x2={L + 272} y1={H - 8} y2={H - 8} stroke="var(--warn)" strokeWidth={2} strokeDasharray="6 4" />
            <text x={L + 278} y={H - 5} fontSize={10} fill="var(--muted)">trend</text>
          </>
        )}
      </g>
    </svg>
  );
}

/* ── Capacity ─────────────────────────────────────────────────────────────── */
function CapacityPanel({ capacity }: { capacity: CapState[] }) {
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h">
        <div>
          <h3>Capacity outlook</h3>
          <div className="meta">
            Current occupancy and a 30/60/90-day projection per programme type, from recent
            entry and exit rates. Net flow is entries minus exits per month — a positive figure
            means the type is filling.
          </div>
        </div>
      </div>

      <div className="scroll">
        <table className="bnl-table">
          <thead>
            <tr>
              <th>Programme type</th>
              <th className="num">Capacity</th>
              <th className="num">Occupied now</th>
              <th className="num">30d</th>
              <th className="num">60d</th>
              <th className="num">90d</th>
              <th className="num">Net flow / mo</th>
            </tr>
          </thead>
          <tbody>
            {capacity.map((c) => (
              <tr key={c.state}>
                <td>
                  <span className="ty" style={{ background: hexSoft(c.color), color: c.color }}>{c.state}</span>{' '}
                  {c.label}
                  <div className="bnl-sub">{fmtInt(c.current)} of {fmtInt(c.beds)}</div>
                </td>
                <td className="num">{fmtInt(c.beds)}</td>
                <td className="num"><Occ v={c.occ_now} /></td>
                <td className="num"><Occ v={c.proj_30} /></td>
                <td className="num"><Occ v={c.proj_60} /></td>
                <td className="num"><Occ v={c.proj_90} /></td>
                <td className="num" style={{ color: c.net_mo > 0 ? 'var(--danger)' : c.net_mo < 0 ? 'var(--accent)' : undefined }}>
                  {c.net_mo > 0 ? '+' : ''}{Number(c.net_mo.toFixed(1))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="bnl-method">
        A projection assumes the recent entry/exit pace holds; it does not model new inventory,
        seasonal shifts, or policy changes. Rapid-rehousing and other scattered-site types can
        read above 100% because clients are counted against a lease-up target, not fixed beds —
        the same convention as the Unit Utilization tab.
      </p>
    </div>
  );
}

function Occ({ v }: { v: number | null }) {
  if (v == null) return <>—</>;
  const color = v > 110 ? 'var(--mid)' : v >= 85 ? 'var(--accent)' : v >= 65 ? 'var(--warn)' : 'var(--danger)';
  return <span style={{ color, fontWeight: 700 }}>{Number(v.toFixed(1))}%</span>;
}

/** Translate a solid hex to a faint background for the type chip. */
function hexSoft(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'var(--track)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.14)`;
}
