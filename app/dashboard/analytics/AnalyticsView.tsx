'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { DEST_LABELS, SUBSIDY_LABELS, fmtInt, typeAbbr } from '../../../lib/format';
import { IconTrendUp, IconAlertTriangle, IconClock, IconHome, IconInflow, IconShuffle,
  IconFunnel, IconTarget, IconSliders, IconDownload } from '../../../components/icons';
import type { AnalyticsInsights, PathwayIntel, SystemForecast, TrendSeries } from '../../../lib/queries';
import { CopyId, fmt, pct1 } from './shared';
import { PathwaysSection, BottleneckSection, PredictorSection, SimulatorSection } from './PathwaySections';

/**
 * Analytics — the full port of the old static analytics page (user 2026-09-18:
 * "there were 5 sections"). Five sections mirroring the old tabs:
 *   📈 Trend Projection · ⚠ Return Risk · ⏱ Survival · 🏠 Capacity · 🔮 Inflow
 *
 * Data: meta.analytics_insights (trends + risk + survival — AGGREGATE-ONLY,
 * per-client risk scores are the parked Housing Predictor and never load) +
 * system_forecast (capacity/inflow, stored whole from analytics.json) +
 * /api/analytics/outliers (long-stay clients, agency-scoped by drill RLS).
 * All charts are house-style inline SVG on CSS tokens — no chart library.
 */

type Tab = 'trends' | 'risk' | 'survival' | 'capacity' | 'inflow'
  | 'pathways' | 'bottleneck' | 'predictor' | 'simulator';
const TABS: [Tab, string][] = [
  ['trends', 'Trend Projection'],
  ['risk', 'Return Risk'],
  ['survival', 'Survival'],
  ['capacity', 'Capacity'],
  ['inflow', 'Inflow'],
  ['pathways', 'Pathways'],
  ['bottleneck', 'Bottlenecks'],
  ['predictor', 'Predictor'],
  ['simulator', 'Simulator'],
];
// Stroke icons replace the emoji tab glyphs (2026-09-24 sweep) — same visual
// on county Windows and phones, colored by the tab's own state.
const TAB_ICONS: Record<Tab, React.ReactNode> = {
  trends: <IconTrendUp />, risk: <IconAlertTriangle />, survival: <IconClock />,
  capacity: <IconHome />, inflow: <IconInflow />, pathways: <IconShuffle />,
  bottleneck: <IconFunnel />, predictor: <IconTarget />, simulator: <IconSliders />,
};
const TAB_KEY = 'an-tab';

/* ══════════════ chart primitives ══════════════ */

/**
 * The SVGs scale with their card (viewBox + width:100%), and axis text used to
 * scale with them — 8-unit labels rendered at ~5-6px in the 3-up and wide
 * charts (user 2026-09-25: "so hard to see the axis"). k = viewBox units per
 * CSS px, measured live, so AXIS_PX * k always renders at a true 11px and the
 * margins grow to fit it. `guessPx` is the pre-measure width (SSR/first paint).
 */
const AXIS_PX = 11;
function useSvgScale(W: number, guessPx: number) {
  const ref = useRef<SVGSVGElement>(null);
  const [k, setK] = useState(W / guessPx);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => {
      const w = es[0]?.contentRect.width;
      if (w) setK(W / w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W]);
  return [ref, k] as const;
}
/** Left margin wide enough for the longest y-tick label at AXIS_PX. */
const yAxisWidth = (labels: string[], k: number) =>
  (Math.max(0, ...labels.map((s) => s.length)) * 6.6 + 10) * k;
/**
 * X tick placement by rendered width, not by month count: the first and last
 * labels always show (anchored inward so neither clips), then evenly spaced
 * candidates are kept only if their estimated extent clears every label
 * already placed by a 12px gap. "Oct 2022"/"Sep 2023" used to overprint.
 */
function xTicks(labels: string[], x: (i: number) => number, k: number, maxTicks: number) {
  type Tick = { i: number; anchor: 'start' | 'middle' | 'end'; a: number; b: number };
  const n = labels.length;
  if (!n) return [];
  const width = (i: number) => labels[i].length * 6.4 * k;
  const make = (i: number): Tick => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const w = width(i); const cx = x(i);
    const a = anchor === 'start' ? cx : anchor === 'end' ? cx - w : cx - w / 2;
    return { i, anchor, a, b: a + w };
  };
  const gap = 12 * k;
  const placed: Tick[] = [make(0)];
  if (n > 1) {
    const last = make(n - 1);
    if (last.a - placed[0].b >= gap) placed.push(last); else placed[0] = last;
  }
  const step = Math.max(1, Math.round((n - 1) / Math.max(1, maxTicks - 1)));
  for (let i = step; i < n - 1; i += step) {
    const t = make(i);
    if (placed.every((p) => t.b + gap <= p.a || t.a >= p.b + gap)) placed.push(t);
  }
  return placed.sort((p, q) => p.i - q.i);
}

/**
 * Hover readout (user 2026-09-25): pointer x → nearest month index. The
 * readout is HTML over the SVG (not SVG text) so it never scales with the card.
 */
function useHoverAt(W: number, toIndex: (vx: number) => number | null) {
  const [hov, setHov] = useState<number | null>(null);
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHov(toIndex(((e.clientX - r.left) / r.width) * W));
  };
  return { hov, handlers: { onMouseMove, onMouseLeave: () => setHov(null) } };
}
/** Point series (x = L + i·span/(n-1)): nearest index. */
function useHoverIndex(n: number, W: number, L: number, R: number) {
  return useHoverAt(W, (vx) => {
    const i = Math.round(((vx - L) / (W - L - R)) * Math.max(n - 1, 1));
    return i < 0 || i > n - 1 ? null : i;
  });
}
/** Bar series (n equal bands from L): the band under the pointer. */
function useHoverBand(n: number, W: number, L: number, R: number) {
  return useHoverAt(W, (vx) => {
    const i = Math.floor(((vx - L) / (W - L - R)) * n);
    return i < 0 || i > n - 1 ? null : i;
  });
}
/** Readout sits beside the guide line, flipping left past 60% so it never clips. */
const tipPos = (frac: number): React.CSSProperties => (frac > 0.6
  ? { right: `calc(${(1 - frac) * 100}% + 10px)` }
  : { left: `calc(${frac * 100}% + 10px)` });
const fmtTip = (v: number, pct?: boolean, days?: boolean) =>
  pct ? `${v.toFixed(1)}%` : days ? `${Math.round(v)} days` : fmt(v);

/** Y-axis scale over the non-null values of every series considered. */
function yDomain(vals: (number | null | undefined)[], padFrac = 0.08): [number, number] {
  const nums = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (!nums.length) return [0, 1];
  let lo = Math.min(...nums); let hi = Math.max(...nums);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * padFrac;
  lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  return [lo, hi + pad];
}

/** Trend-projection chart: actuals (solid) + linear fit (dashed muted) +
 *  6-mo projection (dashed warn) + 95% CI band. The old page's card anatomy. */
function TrendProjChart({ s, periods, pct, days }: {
  s: TrendSeries; periods: string[]; pct?: boolean; days?: boolean;
}) {
  const [ref, k] = useSvgScale(520, 400);
  const values = s.values ?? [];
  const fit = s.fit ?? [];
  const proj = s.proj ?? [];
  const lo = s.proj_lower ?? [];
  const hi = s.proj_upper ?? [];
  const nAct = values.length;
  const n = nAct + proj.length;
  const [y0, y1] = yDomain([...values, ...fit, ...lo, ...hi]);
  const fmtY = (v: number) => (pct ? `${Math.round(v * 10) / 10}%` : days ? `${Math.round(v)}d` : fmt(v));
  const yT = [0, 0.5, 1].map((g) => y0 + (y1 - y0) * g);
  const fs = AXIS_PX * k;
  const W = 520, H = 185, L = yAxisWidth(yT.map(fmtY), k), R = 8 * k, T = 8 * k, B = 24 * k;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  const path = (pts: [number, number | null | undefined][]) => {
    let d = ''; let started = false;
    for (const [i, v] of pts) {
      if (v == null) { started = false; continue; }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    }
    return d;
  };
  const lastIdx = (() => { for (let i = nAct - 1; i >= 0; i--) if (values[i] != null) return i; return -1; })();
  // CI band polygon over the projection months, anchored at the last actual.
  const band = lastIdx >= 0 && proj.length ? [
    ...hi.map((v, k) => `${x(nAct + k).toFixed(1)},${y(v).toFixed(1)}`),
    ...[...lo].reverse().map((v, k) => `${x(n - 1 - k).toFixed(1)},${y(v).toFixed(1)}`),
  ].join(' ') : '';
  const projPts: [number, number | null][] = lastIdx >= 0
    ? [[lastIdx, values[lastIdx] as number], ...proj.map((v, k) => [nAct + k, v] as [number, number])]
    : [];
  const allLabels = [...periods, ...(s.proj_labels ?? [])];
  const { hov, handlers } = useHoverIndex(n, W, L, R);
  const hAct = hov != null && hov < nAct ? values[hov] : null;
  const hProj = hov != null && hov >= nAct ? proj[hov - nAct] : null;
  const hVal = hAct ?? hProj;
  return (
    <div style={{ position: 'relative' }}>
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      {...handlers}>
      {yT.map((v, g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={k} />
          <text x={L - 6 * k} y={y(v) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)"
            className="num">{fmtY(v)}</text>
        </g>
      ))}
      {lastIdx >= 0 && proj.length > 0 && (
        <line x1={x(lastIdx)} x2={x(lastIdx)} y1={T} y2={H - B}
          stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 3" />
      )}
      {band && <polygon points={band} fill="var(--primary)" opacity={0.1} />}
      <path d={path(fit.map((v, i) => [i, v]))} fill="none" stroke="var(--muted)"
        strokeWidth={1.2} strokeDasharray="3 3" opacity={0.55} />
      <path d={path(values.map((v, i) => [i, v]))} fill="none" stroke="var(--primary)" strokeWidth={1.8} />
      {projPts.length > 1 && (
        <path d={path(projPts)} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="5 3" />
      )}
      {xTicks(allLabels, x, k, 5).map(({ i, anchor }) => (
        <text key={`${allLabels[i]}-${i}`} x={x(i)} y={H - 7 * k} textAnchor={anchor} fontSize={fs}
          fill="var(--muted)">{allLabels[i]}</text>
      ))}
      {hov != null && (
        <g pointerEvents="none">
          <line x1={x(hov)} x2={x(hov)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={k} />
          {hVal != null && (
            <circle cx={x(hov)} cy={y(hVal)} r={3.5 * k} stroke="var(--card)" strokeWidth={1.5 * k}
              fill={hAct != null ? 'var(--primary)' : 'var(--warn)'} />
          )}
        </g>
      )}
      {/* full-plot hit area so hovering blank space still tracks */}
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
    </svg>
    {hov != null && (
      <div className="ctip" style={tipPos(x(hov) / W)}>
        <b>{allLabels[hov]}</b>
        {hAct != null ? (
          <span className="num">{fmtTip(hAct, pct, days)}</span>
        ) : hProj != null ? (
          <>
            <span className="num" style={{ color: 'var(--warn)' }}>Projected {fmtTip(hProj, pct, days)}</span>
            {lo[hov - nAct] != null && hi[hov - nAct] != null && (
              <span className="num ctip-sub">
                95% range {fmtTip(lo[hov - nAct], pct, days)} – {fmtTip(hi[hov - nAct], pct, days)}
              </span>
            )}
          </>
        ) : (
          <span className="ctip-sub">No data this month</span>
        )}
      </div>
    )}
    </div>
  );
}

/** Multi-series line chart (per-type trends) with an external toggle set. */
function MultiLine({ series, periods, active, pct, days }: {
  series: { key: string; label: string; color: string; values: (number | null)[] }[];
  periods: string[]; active: Set<string>; pct?: boolean; days?: boolean;
}) {
  const [ref, k] = useSvgScale(1000, 620);
  const shown = series.filter((s) => active.has(s.key));
  const [y0, y1] = yDomain(shown.flatMap((s) => s.values));
  const fmtY = (v: number) => (pct ? `${Math.round(v * 10) / 10}%` : days ? `${Math.round(v)}d` : fmt(v));
  const yT = [0, 0.25, 0.5, 0.75, 1].map((g) => y0 + (y1 - y0) * g);
  const fs = AXIS_PX * k;
  const W = 1000, H = 260, L = yAxisWidth(yT.map(fmtY), k), R = 10 * k, T = 10 * k, B = 24 * k;
  const n = periods.length;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  const path = (vals: (number | null)[]) => {
    let d = ''; let started = false;
    vals.forEach((v, i) => {
      if (v == null) { started = false; return; }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    });
    return d;
  };
  const { hov, handlers } = useHoverIndex(n, W, L, R);
  const hRows = hov == null ? [] : shown
    .map((s) => ({ s, v: s.values[hov] }))
    .filter((r): r is { s: typeof shown[number]; v: number } => r.v != null)
    .sort((a, b) => b.v - a.v);
  return (
    <div style={{ position: 'relative' }}>
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      {...handlers}>
      {yT.map((v, g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={k} />
          <text x={L - 6 * k} y={y(v) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)"
            className="num">{fmtY(v)}</text>
        </g>
      ))}
      {shown.map((s) => (
        <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={1.8 * k} opacity={0.9} />
      ))}
      {xTicks(periods, x, k, 8).map(({ i, anchor }) => (
        <text key={`${periods[i]}-${i}`} x={x(i)} y={H - 7 * k} textAnchor={anchor} fontSize={fs}
          fill="var(--muted)">{periods[i]}</text>
      ))}
      {hov != null && (
        <g pointerEvents="none">
          <line x1={x(hov)} x2={x(hov)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={k} />
          {hRows.map(({ s, v }) => (
            <circle key={s.key} cx={x(hov)} cy={y(v)} r={3.5 * k} fill={s.color}
              stroke="var(--card)" strokeWidth={1.5 * k} />
          ))}
        </g>
      )}
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
    </svg>
    {hov != null && (
      <div className="ctip" style={tipPos(x(hov) / W)}>
        <b>{periods[hov]}</b>
        {hRows.length ? hRows.map(({ s, v }) => (
          <span key={s.key} className="ctip-row">
            <i style={{ background: s.color }} />{s.label}
            <span className="num ctip-v">{fmtTip(v, pct, days)}</span>
          </span>
        )) : <span className="ctip-sub">No data this month</span>}
      </div>
    )}
    </div>
  );
}

/** Kaplan-Meier step chart: P(still enrolled) over days 0–730, one line per type. */
function KMChart({ types, curveKey }: {
  types: { label: string; color: string; curve: { x: number; y: number }[] }[]; curveKey: string;
}) {
  const [ref, k] = useSvgScale(520, 480);
  const fs = AXIS_PX * k;
  const W = 520, H = 240, L = yAxisWidth(['100%'], k), R = 14 * k, T = 8 * k, B = 38 * k;
  const x = (d: number) => L + (Math.min(d, 730) / 730) * (W - L - R);
  const y = (p: number) => T + (H - T - B) * (1 - p);
  const path = (curve: { x: number; y: number }[]) => {
    if (!curve.length) return '';
    let d = `M${x(curve[0].x).toFixed(1)},${y(curve[0].y).toFixed(1)}`;
    for (let i = 1; i < curve.length; i++) {
      d += `H${x(curve[i].x).toFixed(1)}V${y(curve[i].y).toFixed(1)}`;
    }
    return d;
  };
  // Hover = a day (0–730); each curve is a step function, so its value on day
  // d is the last step at or before d.
  const { hov: day, handlers } = useHoverAt(W, (vx) => {
    const d = Math.round(((vx - L) / (W - L - R)) * 730);
    return d < 0 || d > 730 ? null : d;
  });
  const at = (curve: { x: number; y: number }[], d: number) => {
    let v: number | null = null;
    for (const p of curve) { if (p.x <= d) v = p.y; else break; }
    return v;
  };
  const hRows = day == null ? [] : types
    .map((t) => ({ t, v: at(t.curve, day) }))
    .filter((r): r is { t: typeof types[number]; v: number } => r.v != null)
    .sort((a, b) => b.v - a.v);
  return (
    <div style={{ position: 'relative' }}>
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={curveKey}
      {...handlers}>
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={L} x2={W - R} y1={y(p)} y2={y(p)} stroke="var(--hair)" strokeWidth={k} />
          <text x={L - 6 * k} y={y(p) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)"
            className="num">{Math.round(p * 100)}%</text>
        </g>
      ))}
      {[0, 90, 180, 365, 545, 730].map((d) => (
        <text key={d} x={x(d)} y={H - 22 * k} textAnchor={d === 0 ? 'start' : d === 730 ? 'end' : 'middle'}
          fontSize={fs} fill="var(--muted)" className="num">{d}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 5 * k} textAnchor="middle" fontSize={fs} fill="var(--faint)">days since enrollment</text>
      {types.map((t) => (
        <path key={t.label} d={path(t.curve)} fill="none" stroke={t.color} strokeWidth={1.8 * k} />
      ))}
      {day != null && (
        <g pointerEvents="none">
          <line x1={x(day)} x2={x(day)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={k} />
          {hRows.map(({ t, v }) => (
            <circle key={t.label} cx={x(day)} cy={y(v)} r={3.5 * k} fill={t.color}
              stroke="var(--card)" strokeWidth={1.5 * k} />
          ))}
        </g>
      )}
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
    </svg>
    {day != null && (
      <div className="ctip" style={tipPos(x(day) / W)}>
        <b>Day {day}</b>
        <span className="ctip-sub">{curveKey === 'ph' ? 'not yet exited to PH' : 'still enrolled'}</span>
        {hRows.map(({ t, v }) => (
          <span key={t.label} className="ctip-row">
            <i style={{ background: t.color }} />{t.label}
            <span className="num ctip-v">{(v * 100).toFixed(1)}%</span>
          </span>
        ))}
      </div>
    )}
    </div>
  );
}

/** Horizontal bar row (label · scaled bar · value) — shared across sections. */
function BarRow({ label, value, max, display, color, sub, tip }: {
  label: string; value: number; max: number; display: string; color: string; sub?: string;
  /** Hover explanation of what the metric/factor means. */
  tip?: string;
}) {
  return (
    <div title={tip} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', cursor: tip ? 'help' : undefined }}>
      <span style={{ flex: '0 0 240px', fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}{sub && <span className="bnl-sub"> · {sub}</span>}
      </span>
      <span style={{ flex: 1, height: 10, background: 'var(--hair)', borderRadius: 5, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', borderRadius: 5,
          width: `${Math.max((Math.abs(value) / Math.max(max, 1e-9)) * 100, 1.5)}%`, background: color }} />
      </span>
      <span className="num" style={{ flex: '0 0 64px', textAlign: 'right', fontSize: 12.5, fontWeight: 700 }}>{display}</span>
    </div>
  );
}

/** Slope badge: direction vs the metric's good direction (green good / red bad). */
function SlopeBadge({ slope, good, unit }: { slope?: number; good: 'up' | 'down' | null; unit: 'pct' | 'days' | 'count' }) {
  if (slope == null) return null;
  const dir = slope > 0.002 ? 'up' : slope < -0.002 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  const isGood = good == null || dir === 'flat' ? null : dir === good;
  const color = isGood == null ? 'var(--muted)' : isGood ? 'var(--accent)' : 'var(--danger)';
  const bg = isGood == null ? 'var(--hair)' : isGood ? 'var(--accent-light)' : 'var(--danger-light)';
  const mag = Math.abs(slope).toFixed(unit === 'pct' ? 2 : 1);
  const suffix = unit === 'pct' ? '%' : unit === 'days' ? 'd' : '';
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, background: bg, borderRadius: 9, padding: '2px 8px', whiteSpace: 'nowrap' }}>
      {arrow} {mag}{suffix}/mo
    </span>
  );
}

/* ══════════════ capacity / inflow types (system_forecast payload) ══════════════ */

interface CapSide {
  occ_now: number | null; proj_30: number | null; proj_60: number | null; proj_90: number | null;
  entries_mo: number; exits_mo: number; net_mo: number;
  beds?: number; active?: number; units?: number; hh_active?: number; avg_hh_size?: number | null;
}
interface CapRow {
  state: string; label: string; color: string;
  beds: number; current: number; occ_now: number | null;
  proj_30: number | null; proj_60: number | null; proj_90: number | null;
  adult: CapSide | null; family: CapSide | null;
  projects?: { name: string; adult: CapSide | null; family: CapSide | null }[];
  occ_history?: { label: string; adult_occ: number | null; family_occ: number | null }[];
}
interface Inflow {
  months: string[]; total: number[]; future_months: string[];
  wt_forecasts: number[]; trend_forecasts: number[]; slope_per_month: number;
  total_enroll?: number[]; by_state: Record<string, Record<string, number>>;
}

const ADULT_COLOR = 'var(--primary)';
const FAMILY_COLOR = 'var(--warn)';
const occColor = (o: number | null | undefined) =>
  o == null ? 'var(--muted)' : o >= 100 ? 'var(--danger)' : o >= 85 ? 'var(--warn)' : 'var(--accent)';

/** Occupancy sparkline: 12-mo history (solid) + 30/60/90-day forecast (dashed) + 100% line. */
function CapSpark({ row }: { row: CapRow }) {
  const [ref, k] = useSvgScale(460, 440);
  const fs = AXIS_PX * k;
  const W = 460, H = 110, L = yAxisWidth(['100%'], k), R = 8 * k, T = 6 * k, B = 22 * k;
  const hist = row.occ_history ?? [];
  const nH = hist.length;
  const aHist = hist.map((h) => h.adult_occ);
  const aFore = row.adult ? [row.adult.proj_30, row.adult.proj_60, row.adult.proj_90] : [];
  const fHist = hist.map((h) => h.family_occ);
  const fFore = row.family ? [row.family.proj_30, row.family.proj_60, row.family.proj_90] : [];
  const hasFam = row.family != null;
  const all = [...aHist, ...aFore, ...(hasFam ? [...fHist, ...fFore] : []), 100, 0];
  const [y0, y1] = yDomain(all, 0.04);
  const n = nH + 3;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  const path = (vals: (number | null)[], from = 0) => {
    let d = ''; let started = false;
    vals.forEach((v, k) => {
      if (v == null) { started = false; return; }
      d += `${started ? 'L' : 'M'}${x(from + k).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    });
    return d;
  };
  const lastA = aHist.length ? aHist[aHist.length - 1] : null;
  const lastF = fHist.length ? fHist[fHist.length - 1] : null;
  const labels = [...hist.map((h) => h.label), '+30d', '+60d', '+90d'];
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      <line x1={L} x2={W - R} y1={y(100)} y2={y(100)} stroke="var(--danger)" strokeWidth={k} strokeDasharray="4 3" opacity={0.6} />
      <text x={L - 6 * k} y={y(100) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)" className="num">100%</text>
      <path d={path(aHist)} fill="none" stroke={ADULT_COLOR} strokeWidth={1.8} />
      {lastA != null && (
        <path d={path([lastA, ...aFore], nH - 1)} fill="none" stroke={ADULT_COLOR} strokeWidth={1.8} strokeDasharray="5 3" />
      )}
      {hasFam && <path d={path(fHist)} fill="none" stroke={FAMILY_COLOR} strokeWidth={1.8} />}
      {hasFam && lastF != null && (
        <path d={path([lastF, ...fFore], nH - 1)} fill="none" stroke={FAMILY_COLOR} strokeWidth={1.8} strokeDasharray="5 3" />
      )}
      {xTicks(labels, x, k, 6).map(({ i, anchor }) => (
        <text key={`${labels[i]}-${i}`} x={x(i)} y={H - 6 * k} textAnchor={anchor} fontSize={fs}
          fill="var(--muted)">{labels[i]}</text>
      ))}
    </svg>
  );
}

/* ══════════════ the view ══════════════ */

export default function AnalyticsView({ a, forecast, pi }: {
  a: AnalyticsInsights; forecast: SystemForecast; pi: PathwayIntel | null;
}) {
  const [tab, setTabState] = useState<Tab>('trends');
  // ?section=…&pid=… deep link (BNL drawer's "open in Analytics") wins over
  // the remembered tab; the pid prefilters the section's client list and
  // auto-opens that client's dossier.
  const [linkPid, setLinkPid] = useState<string | null>(null);
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const sec = sp.get('section') as Tab | null;
      if (sec && TABS.some(([k]) => k === sec)) {
        setTabState(sec);
        setLinkPid(sp.get('pid'));
        return;
      }
      const saved = localStorage.getItem(TAB_KEY) as Tab | null;
      if (saved && TABS.some(([k]) => k === saved)) setTabState(saved);
    } catch { /* private mode */ }
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ }
  };

  const capacity = (forecast.capacity as unknown as CapRow[] | null) ?? [];
  const inflow = forecast.inflow as unknown as Inflow | null;

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          <div>
            <h3>Analytics</h3>
            <div className="meta">
              Trend projections · return-risk model · survival analysis · capacity &amp; inflow forecasts
              {a.generated ? ` — data through ${a.generated}` : ''}. System-wide figures; the long-stay
              outlier list is scoped to your agency&rsquo;s projects.
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0' }}>
        <div className="seg" role="tablist" aria-label="Analytics sections" style={{ flexWrap: 'wrap' }}>
          {TABS.map(([k, lbl]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k}
              className={tab === k ? 'on' : undefined} onClick={() => setTab(k)}>{TAB_ICONS[k]}{lbl}</button>
          ))}
        </div>
      </div>

      {tab === 'trends' && <TrendsSection a={a} />}
      {tab === 'risk' && <RiskSection a={a} initialPid={linkPid} />}
      {tab === 'survival' && <SurvivalSection a={a} />}
      {tab === 'capacity' && <CapacitySection capacity={capacity} />}
      {tab === 'inflow' && <InflowSection inflow={inflow} />}
      {tab === 'pathways' && (pi ? <PathwaysSection pi={pi} /> : <PiEmpty />)}
      {tab === 'bottleneck' && (pi ? <BottleneckSection pi={pi} /> : <PiEmpty />)}
      {tab === 'predictor' && (pi ? <PredictorSection pi={pi} initialPid={linkPid} /> : <PiEmpty />)}
      {tab === 'simulator' && (pi ? <SimulatorSection pi={pi} /> : <PiEmpty />)}
    </>
  );
}

function PiEmpty() {
  return (
    <div className="panel" style={{ padding: 24 }}>
      <p className="bnl-sub">
        The Pathway Intelligence payload hasn&rsquo;t been loaded yet — run
        generate_pathways.py then the pipeline&rsquo;s meta load and this section fills in.
      </p>
    </div>
  );
}

/* ══════════════ 📈 Trends ══════════════ */

const TREND_DEFS: { key: string; title: string; sub: string; pct?: boolean; days?: boolean; good: 'up' | 'down' | null }[] = [
  { key: 'ph_rate', title: 'PH Exit Rate (M7b.1)', sub: 'Unduplicated ES/TH/SH/RRH leavers → PH', pct: true, good: 'up' },
  { key: 'total_ph_exits', title: 'Total PH Exits', sub: 'Unduplicated clients exiting to PH — M2 universe', good: null },
  { key: 'clients', title: 'Unduplicated Clients', sub: 'System view: one count per person', good: null },
  { key: 'unsub_rate', title: 'Unsubsidized Exit Rate', sub: 'Exits to unsubsidized housing — M7b.1', pct: true, good: 'up' },
  { key: 'so_rate', title: 'SO Success Rate (M7a.1)', sub: 'Street Outreach leavers to positive destinations', pct: true, good: 'up' },
  { key: 'ph_retention', title: 'PH Retention Rate (M7b.2)', sub: 'Clients retaining PH housing at follow-up', pct: true, good: 'up' },
  { key: 'avg_los', title: 'Avg Shelter LOS (M1a)', sub: 'ES + Safe Haven + TH — unduplicated', days: true, good: 'down' },
  { key: 'return_rate', title: '2-Year Return Rate (M2)', sub: 'Returns to ES/TH/SO/SH within 24 months', pct: true, good: 'down' },
  { key: 'first_time', title: 'First-Time Homeless (M5)', sub: 'New entries with no prior 24-mo enrollment', good: 'down' },
];

function TrendsSection({ a }: { a: AnalyticsInsights }) {
  const periods = a.trend.periods ?? [];
  const byType = a.trend.by_type ?? {};
  const typeKeys = Object.keys(byType);
  const [active, setActive] = useState<Set<string>>(() => new Set(typeKeys));
  const toggle = (k: string) => setActive((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const last = (s?: TrendSeries | null) => {
    const v = s?.values ?? [];
    for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i];
    return null;
  };

  return (
    <>
      <div className="grouplabel">System-wide trend projection
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          linear regression on monthly actuals — dashed orange = 6-month projection, shaded band = 95% CI
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
        {TREND_DEFS.map((def) => {
          const s = a.trend.system?.[def.key];
          if (!s?.values?.length) return null;
          const v = last(s);
          return (
            <div key={def.key} className="panel" style={{ padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{def.title}</span>
                <SlopeBadge slope={s.slope_pm} good={def.good}
                  unit={def.pct ? 'pct' : def.days ? 'days' : 'count'} />
                <span style={{ flex: 1 }} />
                <span className="num" style={{ fontSize: 15, fontWeight: 800 }}>
                  {v == null ? '—' : def.pct ? pct1(v) : def.days ? `${Math.round(v)}d` : fmt(v)}
                </span>
              </div>
              <div className="bnl-sub" style={{ margin: '2px 0 6px' }}>{def.sub}</div>
              <TrendProjChart s={s} periods={periods} pct={def.pct} days={def.days} />
            </div>
          );
        })}
      </div>

      <div className="grouplabel" style={{ marginTop: 18 }}>By project type
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>click a type to toggle</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {typeKeys.map((k) => {
          const t = byType[k];
          const on = active.has(k);
          return (
            <button key={k} type="button" onClick={() => toggle(k)}
              className="btn" style={{ fontSize: 12, padding: '4px 10px', opacity: on ? 1 : 0.4,
                borderColor: t.color, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: t.color, display: 'inline-block' }} />
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
        {([
          { key: 'ph_rate' as const, title: 'PH Exit Rate by Type', pct: true, days: false },
          { key: 'avg_los' as const, title: 'Avg LoS by Type', pct: false, days: true },
        ]).map((def) => (
          <div key={def.key} className="panel" style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>{def.title}</div>
            <MultiLine periods={periods} active={active} pct={def.pct} days={def.days}
              series={typeKeys.map((k) => ({
                key: k, label: byType[k].label, color: byType[k].color,
                values: byType[k][def.key]?.values ?? [],
              }))} />
          </div>
        ))}
      </div>
    </>
  );
}

/* ══════════════ ⚠️ Return risk ══════════════ */

interface RiskClientRow {
  pid: string; project_id: number; project: string; ptype: string;
  exit: string | null; los: number | null; eps: number | null;
  score: number; bucket: string;
  dest?: number | null; sub?: number | null;
  // Horizon probabilities in percent; `score` is the 24-month (overall).
  s6?: number | null; s12?: number | null;
  // Already-returned: the observed return happened `retd` days after this
  // exit — a realized outcome, not a forecast.
  ret?: number | null; retd?: number | null;
}
const TIER_COLOR: Record<string, string> = {
  'Low (<20%)': 'var(--accent)',
  'Moderate (20–40%)': 'var(--warn)',
  'Elevated (40–60%)': '#f97316',
  'High (>60%)': 'var(--danger)',
};

/** Hover explanations per return-model feature (keyed by feat_col so they
 *  survive label edits). Written from the 2026-09-18 factor analysis — keep
 *  in sync with the model when features change. */
const RETURN_FACTOR_TIPS: Record<string, string> = {
  pt_0: 'The exit was from an ES (entry/exit) program — measured against the other program types.',
  pt_2: 'The exit was from Transitional Housing — measured against the other program types.',
  pt_3: 'The exit was from PSH — measured against the other program types.',
  pt_4: 'The exit was from Street Outreach — measured against the other program types.',
  pt_13: 'The exit was from RRH — measured against the other program types.',
  los_log: 'Days enrolled before the exit (log scale). Longer stays carry slightly higher return risk system-wide.',
  age_norm: 'The LINEAR piece of the age curve: risk climbs steadily from young adulthood (12% at 18–24) into the late 50s (23% at 55–61). Reads TOGETHER with the two age-band factors — the three jointly draw one hump-shaped curve.',
  is_45_61: 'Band adjustment on top of the linear age term — near zero because the linear term already carries the mid-age rise. Raw rates peak in this band (23.1%).',
  is_62p: 'The BEND at retirement age: relative to where the linear age trend would put them, 62+ leavers return less (17.8% raw — deep-subsidy senior placements are common). Net of both terms, a 62+ client sits above a young adult but below the 55–61 peak — not a contradiction, one curve in pieces.',
  prior_clip: 'HUD-defined homeless episodes before this exit (capped at 10). More episodes, more returns.',
  prior_enroll_log: 'Raw count of prior program enrollments (log). The strongest factor — leavers with 7+ prior enrollments returned 46.6% of the time.',
  hh_size_c: 'People in the household (capped at 6). Larger households return less: singles ~22%, 4+ member families under 10%.',
  HasMinorChild: 'The household includes a child under 18 — families return far less than single adults.',
  HasIncomeAtExit: 'EMPLOYMENT income recorded at exit — the protective form of income. Benefits-only income is not protective.',
  inc_low: '$1–500/mo total income at exit — the riskiest income band (27% raw), typically marking benefit churn without employment. Measured vs the $0 baseline.',
  inc_mid: '$500–1,500/mo total income at exit, vs the $0 baseline.',
  inc_high: '$1,500+/mo total income at exit, vs the $0 baseline. Adds little once earned income and the landing are known.',
  has_disab: 'HUD 3.08 disabling condition — mostly absorbed by the specific disability flags and pathway factors.',
  HasPhys: 'Physical disability reported at entry (+4pp raw; largely absorbed by correlated factors).',
  HasChronic: 'Chronic health condition reported at entry.',
  HasMH: 'Mental health disorder at entry. Near-zero on its own: MH clients are routed to subsidized housing (50% vs 35%), and the co-occurring risk shows under substance use.',
  HasSUD: 'Substance use disorder at entry — the clinical factor that predicts returns (28–30% raw, alone or co-occurring).',
  gap_log: 'Days between the previous episode and this one (log scale).',
  rapid_return: 'A previous re-entry within 90 days — a churn marker, mostly absorbed by the prior-enrollment count.',
  dest_fam_perm: 'Exited to staying with family or friends on "permanent" tenure — the riskiest PH landing (26%/20% raw returns). The arrangement, not the tenure label, is what fails.',
  dest_psh: 'Rental backed by PSH / GPD TIP / public housing (FY2024 subsidy codes 439/428/434).',
  dest_long_subsidy: 'Ongoing voucher or subsidy (VASH, HCV, EHV, FUP, FYI, other ongoing). Deep subsidies hold at every income level — the strongest protective landing.',
  dest_rrh: 'RRH time-limited subsidy — protective overall; the risk concentrates after the subsidy ends.',
  proj_return_rate: "The exiting program's own historical 2-year return rate (shrunk toward its type average for small programs). A track-record prior, not an individual attribute.",
  recv_proj_return_rate: 'Same idea for the housing program that received the client within 30 days of the exit.',
};

type RiskScoring = NonNullable<NonNullable<AnalyticsInsights['risk']['model']>['scoring']>;
interface RiskDossierClient extends RiskClientRow { feat?: number[] | null }

const riskColor = (p: number) => (p >= 40 ? 'var(--danger)' : p >= 20 ? 'var(--warn)' : 'var(--accent)');

/** Score a feature vector with the 24mo model or a horizon head. */
function scoreVec(sc: RiskScoring, x: number[],
  h?: { weights: number[]; bias: number; feat_mean: number[]; feat_std: number[] }) {
  const W = h?.weights ?? sc.weights; const B = h?.bias ?? sc.bias;
  const MU = h?.feat_mean ?? sc.feat_mean; const SD = h?.feat_std ?? sc.feat_std;
  let z = B;
  for (let i = 0; i < W.length; i++) z += W[i] * ((x[i] - MU[i]) / (SD[i] || 1));
  return (1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))))) * 100;
}

/** Return-risk dossier (user 2026-09-18): why THIS leaver's score is what it
 *  is, their risk-by-when timeline, and their profile re-scored through
 *  alternative exit packages — all weights×features arithmetic on the same
 *  parameters the ETL used, never re-derived logic. */
function RiskDossier({ client, m, onClose }: {
  client: RiskDossierClient;
  m: NonNullable<AnalyticsInsights['risk']['model']>;
  onClose: () => void;
}) {
  const sc = m.scoring ?? null;
  const x = client.feat ?? null;
  const tierC = TIER_COLOR[client.bucket] ?? 'var(--muted)';

  // Contributions are MEAN-RELATIVE (w × z-scored value), so a factor the
  // client DOESN'T have can still contribute — e.g. "Has Minor Children"
  // appears as risk-raising when the client has none, because minors are
  // protective and this client lacks that protection. The `note` states the
  // client's own value (yes/no, above/below avg) so the row reads honestly.
  const BIN_COLS = new Set(['HasMinorChild', 'HasIncomeAtExit', 'inc_low', 'inc_mid', 'inc_high',
    'has_disab', 'HasPhys', 'HasChronic', 'HasMH', 'HasSUD', 'rapid_return',
    'is_45_61', 'is_62p', 'dest_fam_perm', 'dest_psh', 'dest_long_subsidy', 'dest_rrh']);
  const contribs = sc && x
    ? sc.weights.map((w, i) => {
      const col = sc.feat_cols[i];
      const isBin = BIN_COLS.has(col) || col.startsWith('pt_');
      return {
        label: m.features?.[i] ?? col,
        note: isBin ? (x[i] >= 0.5 ? 'yes' : 'no')
          : (x[i] > sc.feat_mean[i] ? 'above avg' : 'below avg'),
        tip: RETURN_FACTOR_TIPS[col],
        val: w * ((x[i] - sc.feat_mean[i]) / (sc.feat_std[i] || 1)),
      };
    }).sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
    : null;
  const raising = (contribs ?? []).filter((c) => c.val > 0.01).slice(0, 4);
  const protecting = (contribs ?? []).filter((c) => c.val < -0.01).slice(0, 4);

  // Exit-package what-ifs: zero the destination + income flags, apply each
  // package, re-score. First row = the actual package as scored.
  const PKG_KEYS = ['dest_fam_perm', 'dest_psh', 'dest_long_subsidy', 'dest_rrh',
    'inc_low', 'inc_mid', 'inc_high', 'HasIncomeAtExit'];
  const SCN: [string, Record<string, number>][] = [
    ['Staying with family/friends · $1–500/mo', { dest_fam_perm: 1, inc_low: 1 }],
    ['Staying with family/friends · no income', { dest_fam_perm: 1 }],
    ['Unsubsidized rental · $1–500/mo', { inc_low: 1 }],
    ['Unsubsidized rental · earned $1,500+', { inc_high: 1, HasIncomeAtExit: 1 }],
    ['Voucher / ongoing subsidy · $1–500/mo', { dest_long_subsidy: 1, inc_low: 1 }],
    ['Voucher / ongoing subsidy · no income', { dest_long_subsidy: 1 }],
    ['Voucher / ongoing subsidy · earned $1,500+', { dest_long_subsidy: 1, inc_high: 1, HasIncomeAtExit: 1 }],
  ];
  const whatIf = sc && x
    ? SCN.map(([label, over]) => {
      const ix = Object.fromEntries(sc.feat_cols.map((c, i) => [c, i]));
      const y = [...x];
      for (const k of PKG_KEYS) if (ix[k] != null) y[ix[k]] = 0;
      for (const [k, v] of Object.entries(over)) if (ix[k] != null) y[ix[k]] = v;
      return { label, pct: scoreVec(sc, y) };
    })
    : null;
  const wiMax = Math.max(...(whatIf ?? []).map((r) => r.pct), client.score, 1e-9);

  const tile = (k: string, v: number | null | undefined) => (
    <div className="hc-t">
      <div className="k">{k}</div>
      <div className="v" style={{ color: v != null ? riskColor(v) : undefined }}>{v != null ? `${Number(v).toFixed(1)}%` : '—'}</div>
    </div>
  );

  return (
    <div className="panel" style={{ padding: '14px 18px', borderLeft: `4px solid ${tierC}`, marginBottom: 14 }}>
      {!!client.ret && (
        <div style={{ padding: '8px 12px', marginBottom: 12, borderRadius: 6, background: 'var(--danger-light)',
          color: 'var(--danger)', fontSize: 13, fontWeight: 600 }}>
          ↩ This return already happened — re-entered homelessness
          {client.retd != null ? ` ${fmt(client.retd)} days` : ''} after this exit.
          The probabilities below were the model&rsquo;s pre-return forecast (now realized);
          for current planning use the housing predictor — they&rsquo;re back in the active caseload.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}><CopyId id={client.pid} /></span>
            <span style={{ fontSize: 11, fontWeight: 700, color: tierC, border: `1px solid ${tierC}`, borderRadius: 10, padding: '1px 8px' }}>{client.bucket}</span>
          </div>
          <div className="bnl-sub">
            {client.project} · {client.ptype} · exited {client.exit ?? '—'} after {fmt(client.los)}d
            {client.dest != null && <> → <b style={{ color: 'var(--text)' }}>{DEST_LABELS[client.dest] ?? `Code ${client.dest}`}</b></>}
            {client.sub != null && <> ({SUBSIDY_LABELS[client.sub] ?? `Subsidy ${client.sub}`})</>}
          </div>
        </div>
        <div className="hc-tiles" style={{ margin: 0 }}>
          {tile('Returns ≤6 mo', client.s6)}
          {tile('≤12 mo', client.s12)}
          {tile('Overall (24 mo)', client.score)}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 14 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
            Why this score — their factors
          </div>
          {contribs == null && <p className="bnl-sub">Factor detail loads with the next data refresh.</p>}
          {raising.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger)', margin: '4px 0' }}>Raising ↑</div>}
          {raising.map((c) => (
            <div key={c.label} title={c.tip} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 6px', background: 'var(--danger-light)', borderRadius: 4, margin: '3px 0', gap: 8, cursor: c.tip ? 'help' : undefined }}>
              <span>{c.label} <span className="bnl-sub" style={{ fontSize: 10.5 }}>· {c.note}</span></span>
              <b className="num" style={{ color: 'var(--danger)' }}>+{c.val.toFixed(2)}</b>
            </div>
          ))}
          {protecting.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', margin: '6px 0 4px' }}>Protecting ↓</div>}
          {protecting.map((c) => (
            <div key={c.label} title={c.tip} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 6px', background: 'var(--accent-light)', borderRadius: 4, margin: '3px 0', gap: 8, cursor: c.tip ? 'help' : undefined }}>
              <span>{c.label} <span className="bnl-sub" style={{ fontSize: 10.5 }}>· {c.note}</span></span>
              <b className="num" style={{ color: 'var(--accent)' }}>{c.val.toFixed(2)}</b>
            </div>
          ))}
          <p className="bnl-sub" style={{ marginTop: 6, fontSize: 10.5 }}>
            Relative to the average leaver — a &ldquo;no&rdquo; on a protective factor shows as raising (missing protection), and vice versa.
          </p>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
            Same person, different exit package
          </div>
          {whatIf == null ? <p className="bnl-sub">What-if scoring loads with the next data refresh.</p> : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{ flex: '0 0 250px', fontSize: 12, fontWeight: 700 }}>As scored (actual package)</span>
                <span style={{ flex: 1, height: 8, background: 'var(--hair)', borderRadius: 4, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.max((client.score / wiMax) * 100, 2)}%`, background: riskColor(client.score), borderRadius: 4 }} />
                </span>
                <b className="num" style={{ flex: '0 0 50px', textAlign: 'right', fontSize: 12, color: riskColor(client.score) }}>{Number(client.score).toFixed(1)}%</b>
              </div>
              {whatIf.map((r) => (
                <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                  <span className="bnl-sub" style={{ flex: '0 0 250px', fontSize: 12 }}>{r.label}</span>
                  <span style={{ flex: 1, height: 8, background: 'var(--hair)', borderRadius: 4, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${Math.max((r.pct / wiMax) * 100, 2)}%`, background: riskColor(r.pct), borderRadius: 4 }} />
                  </span>
                  <b className="num" style={{ flex: '0 0 50px', textAlign: 'right', fontSize: 12, color: riskColor(r.pct) }}>{r.pct.toFixed(1)}%</b>
                </div>
              ))}
              <p className="bnl-sub" style={{ marginTop: 8, fontSize: 11 }}>
                Model estimates for this profile — associations, not guaranteed treatment effects.
              </p>
            </>
          )}
        </div>
      </div>

      <button type="button" className="btn" onClick={onClose} style={{ marginTop: 10, fontSize: 12 }}>✕ Close</button>
    </div>
  );
}

function RiskSection({ a, initialPid = null }: { a: AnalyticsInsights; initialPid?: string | null }) {
  const m = a.risk.model;
  // Client return-risk list (user directive 2026-09-18) — agency-scoped by
  // the an:risk drill RLS, hashed IDs only. Hooks live above the early
  // return (rules of hooks).
  const [clients, setClients] = useState<{ asOf: string | null; scoped: boolean; rows: RiskClientRow[] } | null>(null);
  const [clErr, setClErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [dossier, setDossier] = useState<RiskDossierClient | null>(null);
  const [dossierBusy, setDossierBusy] = useState<string | null>(null);
  const openDossier = (pid: string) => {
    setDossierBusy(pid);
    fetch(`/api/analytics/risk?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { setDossier(j.client ?? null); setDossierBusy(null); })
      .catch(() => setDossierBusy(null));
  };
  // Deep link from the BNL drawer: prefilter to the client and open their dossier.
  useEffect(() => {
    if (initialPid) { setQ(initialPid); openDossier(initialPid); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPid]);
  useEffect(() => {
    let dead = false;
    fetch('/api/analytics/risk')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!dead) setClients(j); })
      .catch((e: Error) => { if (!dead) setClErr(e.message); });
    return () => { dead = true; };
  }, []);
  // Already-returned leavers are hidden by default (user 2026-09-18): their
  // "risk" is a realized outcome — they belong to the active caseload now.
  // The toggle reveals them for accountability/model-validation reading.
  const [showRet, setShowRet] = useState(false);
  const retCount = useMemo(() => (clients?.rows ?? []).filter((r) => r.ret).length, [clients]);
  const shownClients = useMemo(() => {
    const rows = clients?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (showRet || !r.ret) &&
      (!tier || r.bucket === tier) &&
      (!needle || r.pid.toLowerCase().includes(needle) || r.project.toLowerCase().includes(needle)));
  }, [clients, q, tier, showRet]);

  if (!m || !a.risk.computed) {
    return (
      <div className="panel" style={{ padding: 24 }}>
        <p className="bnl-sub">Insufficient historical data to train the returns-risk model.</p>
      </div>
    );
  }
  const buckets = a.risk.buckets ?? {};
  const BUCKET_ORDER = ['Low (<20%)', 'Moderate (20–40%)', 'Elevated (40–60%)', 'High (>60%)'];
  const BUCKET_COLORS = ['var(--accent)', 'var(--warn)', '#f97316', 'var(--danger)'];
  const bTotal = BUCKET_ORDER.reduce((s, k) => s + (buckets[k] ?? 0), 0);
  const elevated = (buckets['High (>60%)'] ?? 0) + (buckets['Elevated (40–60%)'] ?? 0);
  // Direction comes ONLY from importances_signed (signed z-scored
  // coefficients). The older `importances` are |w| — coloring by their
  // "sign" painted every factor as risk-raising, protective ones included.
  // ALL factors, strongest first — no cap (user 2026-09-18: the expanded
  // list is the point; small-weight factors like the income buckets must
  // still be visible).
  const signed = m.importances_signed ?? null;
  const featCols = m.scoring?.feat_cols ?? null;
  const factors = (m.features ?? []).map((f, i) => ({
    f, w: (signed ?? m.importances)?.[i] ?? 0,
    tip: featCols ? RETURN_FACTOR_TIPS[featCols[i]] : undefined,
  })).sort((x, y) => Math.abs(y.w) - Math.abs(x.w));
  const wMax = Math.max(...factors.map((x) => Math.abs(x.w)), 1e-9);
  const hist = a.risk.histogram;
  const histMax = Math.max(...(hist?.counts ?? [1]));
  const byType = [...(a.risk.by_type ?? [])].sort((x, y) => y.avg_risk - x.avg_risk);
  const riskMax = Math.max(...byType.map((t) => t.avg_risk), 1e-9);

  return (
    <>
      <div className="dq-kpi-grid">
        <div className="dq-kpi" title="Area under the ROC curve on held-out data — 0.5 is coin-flip, 1.0 is perfect.">
          <div className="dq-kpi-label">Model AUC</div>
          <div className="dq-kpi-val" style={{ color: 'var(--primary)' }}>{Number(m.auc).toFixed(2)}</div>
          <div className="dq-kpi-sub">returns-risk model quality</div>
        </div>
        <div className="dq-kpi">
          <div className="dq-kpi-label">Accuracy</div>
          <div className="dq-kpi-val">{(Number(m.accuracy) * 100).toFixed(1)}%</div>
          <div className="dq-kpi-sub">on held-out exits</div>
        </div>
        <div className="dq-kpi">
          <div className="dq-kpi-label">Trained on</div>
          <div className="dq-kpi-val">{fmt(m.train_n)}</div>
          <div className="dq-kpi-sub">PH exits · {(Number(m.train_pos_rate) * 100).toFixed(1)}% returned</div>
        </div>
        <div className="dq-kpi">
          <div className="dq-kpi-label">Recent leavers scored</div>
          <div className="dq-kpi-val">{fmt(m.score_n)}</div>
          <div className="dq-kpi-sub">aggregate distribution only</div>
        </div>
        <div className="dq-kpi" title="Leavers whose predicted 2-year return risk is above 40%">
          <div className="dq-kpi-label">Elevated + high risk</div>
          <div className="dq-kpi-val" style={{ color: elevated > 0 ? 'var(--warn)' : 'var(--accent)' }}>{fmt(elevated)}</div>
          <div className="dq-kpi-sub">predicted &gt;40% return risk</div>
        </div>
      </div>

      <p className="bnl-method" style={{ margin: '12px 0' }}>
        <b>How to read this:</b> each client who recently exited to permanent housing is scored for
        probability of returning to homelessness — the headline score covers 24 months (the HUD M2
        window), and the <b>≤6 mo</b> column is the &ldquo;prioritize outreach now&rdquo; signal
        (most returns happen early{m.horizons_meta?.['6mo'] ? `; the 6-month model is also the sharpest, AUC ${Number(m.horizons_meta['6mo'].auc).toFixed(2)}` : ''}).
        Factors include program type, length of stay, prior episodes and enrollments, household,
        income, disabilities, and where the exit landed. The client list is scoped to your
        agency&rsquo;s projects and shows hashed record IDs, never names.
      </p>

      <div className="grouplabel">What drives returns to homelessness
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          model factor weights, strongest first — learned from {fmt(m.train_n)} historical PH exits
        </span>
      </div>
      {signed ? (
        // Split view (user 2026-09-18): risk-raising and protective factors
        // side by side, bars on ONE shared scale so magnitudes compare
        // across the two columns.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          <div className="panel" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', marginBottom: 6 }}>
              ↑ Raises return risk
            </div>
            {factors.filter(({ w }) => w >= 0).map(({ f, w, tip }) => (
              <BarRow key={f} label={f} value={w} max={wMax} tip={tip}
                display={`+${w.toFixed(2)}`} color="var(--danger)" />
            ))}
          </div>
          <div className="panel" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
              ↓ Protective
            </div>
            {factors.filter(({ w }) => w < 0).map(({ f, w, tip }) => (
              <BarRow key={f} label={f} value={w} max={wMax} tip={tip}
                display={w.toFixed(2)} color="var(--accent)" />
            ))}
          </div>
        </div>
      ) : (
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div className="bnl-sub" style={{ marginBottom: 8 }}>
            Model factor magnitudes, strongest first (direction loads with the next data refresh).
          </div>
          {factors.map(({ f, w }) => (
            <BarRow key={f} label={f} value={w} max={wMax}
              display={w.toFixed(2)} color="var(--primary)" />
          ))}
        </div>
      )}

      {a.risk.scenarios && (
        <>
          <div className="grouplabel" style={{ marginTop: 18 }}>Who carries the housing cost
            <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
              the same &ldquo;average leaver&rdquo; ({pct1(a.risk.scenarios.baseline)} baseline), scored through different exit packages by the live model
            </span>
          </div>
          <div className="panel" style={{ padding: '14px 18px' }}>
            {(() => {
              const rows = a.risk.scenarios!.rows;
              const maxP = Math.max(...rows.map((r) => r.pct), 1e-9);
              let lastGroup = '';
              return rows.map((r) => {
                const showGroup = r.group !== lastGroup;
                lastGroup = r.group;
                const c = r.pct >= 20 ? 'var(--danger)' : r.pct >= 12 ? 'var(--warn)' : 'var(--accent)';
                return (
                  <div key={`${r.group}-${r.label}`}>
                    {showGroup && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase',
                        letterSpacing: '.05em', margin: '10px 0 3px' }}>{r.group}</div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
                      <span style={{ flex: '0 0 170px', fontSize: 12.5 }}>{r.label}</span>
                      <span style={{ flex: 1, height: 10, background: 'var(--hair)', borderRadius: 5, overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', borderRadius: 5,
                          width: `${Math.max((r.pct / maxP) * 100, 2)}%`, background: c }} />
                      </span>
                      <b className="num" style={{ flex: '0 0 56px', textAlign: 'right', fontSize: 12.5, color: c }}>{pct1(r.pct)}</b>
                    </div>
                  </div>
                );
              });
            })()}
            <p className="bnl-method" style={{ margin: '12px 0 0' }}>
              <b>The landing matters more than the income.</b> Subsidized exits hold at every income
              level; income only predicts returns when the client carries the housing cost, and a
              little income + an informal arrangement is the worst combination. These are model
              estimates for an average profile — the observed gap is even wider (leavers with
              $1–500/mo staying with family/friends returned <b>40.6%</b> of the time).
            </p>
          </div>
        </>
      )}

      <div className="grouplabel">Predicted return risk — recent leavers</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div className="bnl-sub" style={{ marginBottom: 8 }}>Distribution — most leavers cluster under 20% risk</div>
          {(hist?.labels ?? []).map((lbl, i) => (
            <BarRow key={lbl} label={lbl} value={hist!.counts[i]} max={histMax}
              display={fmt(hist!.counts[i])} color="var(--primary)" />
          ))}
        </div>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div className="bnl-sub" style={{ marginBottom: 8 }}>Average predicted risk by program type of exit</div>
          {byType.map((t) => (
            <BarRow key={t.type} label={t.label} sub={`${fmt(t.n)} leavers`}
              value={t.avg_risk} max={riskMax}
              display={`${(t.avg_risk * 100).toFixed(1)}%`} color={t.color || 'var(--primary)'} />
          ))}
          <div style={{ marginTop: 14 }}>
            <div className="bnl-sub" style={{ marginBottom: 6 }}>Risk tier breakdown — {fmt(bTotal)} scored exits</div>
            <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--hair)' }}>
              {BUCKET_ORDER.map((k, i) => {
                const n = buckets[k] ?? 0;
                if (!n || !bTotal) return null;
                return <span key={k} title={`${k}: ${fmt(n)}`}
                  style={{ width: `${(n / bTotal) * 100}%`, background: BUCKET_COLORS[i] }} />;
              })}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
              {BUCKET_ORDER.map((k, i) => (
                <span key={k} className="bnl-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: BUCKET_COLORS[i], display: 'inline-block' }} />
                  {k} <b className="num">{fmt(buckets[k] ?? 0)}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grouplabel" style={{ marginTop: 18 }}>Client risk list</div>
      {dossier && <RiskDossier client={dossier} m={m} onClose={() => setDossier(null)} />}
      <div className="panel" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <div className="bnl-sub" style={{ flex: 1, minWidth: 260 }}>
            Recent PH exits scored for 2-year return risk, highest first.
            {clients?.scoped && <> Showing <b>your agency&rsquo;s projects only</b>.</>}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID or program…"
            style={{ padding: '6px 10px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--surface)', color: 'var(--text)', width: 200 }} />
          <select className="fselect" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">All risk tiers</option>
            {Object.keys(TIER_COLOR).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {retCount > 0 && (
            <label className="bnl-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
              title="Leavers whose return has already been observed — realized outcomes, hidden from the forecast list by default">
              <input type="checkbox" checked={showRet} onChange={(e) => setShowRet(e.target.checked)} />
              show already-returned ({fmt(retCount)})
            </label>
          )}
          <a className="btn" href="/api/analytics/risk?format=csv"><IconDownload size={12} /> Export CSV</a>
        </div>
        {clErr && <p className="bnl-sub">Couldn&rsquo;t load the client list ({clErr}).</p>}
        {!clients && !clErr && <p className="bnl-sub">Loading…</p>}
        {clients && (
          shownClients.length === 0 ? (
            <p className="bnl-sub">
              {clients.rows.length === 0
                ? 'No scored exits among your projects yet — the an:risk drill rows load with the next pipeline run.'
                : 'Nothing matches the current filter.'}
            </p>
          ) : (
            <>
              <div className="bnl-sub" style={{ marginBottom: 6 }}>
                Showing {fmt(Math.min(shownClients.length, 500))} of {fmt(shownClients.length)}
                {clients.asOf ? ` · scored as of ${clients.asOf}` : ''} · sorted by risk score
              </div>
              <div className="scroll" style={{ maxHeight: 440, overflowY: 'auto' }}>
                <table className="hm">
                  <thead>
                    <tr>
                      <th>Client ID</th><th>Program</th><th>Type</th><th>Exit date</th>
                      <th>Destination</th>
                      <th style={{ textAlign: 'right' }}>LOS</th>
                      <th style={{ textAlign: 'right' }}>Prior eps.</th>
                      <th style={{ textAlign: 'right' }} title="Probability of returning within 6 months — the 'prioritize outreach now' signal">≤6 mo</th>
                      <th style={{ textAlign: 'right' }} title="Probability of returning within 24 months — the headline score">Overall (24 mo)</th>
                      <th style={{ textAlign: 'center' }}>Tier</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shownClients.slice(0, 500).map((r) => {
                      const c = TIER_COLOR[r.bucket] ?? 'var(--muted)';
                      return (
                        <tr key={`${r.pid}-${r.project_id}-${r.exit}`}>
                          <td style={{ minWidth: 120 }}><CopyId id={r.pid} /></td>
                          <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.project}>{r.project}</td>
                          <td>{r.ptype}</td>
                          <td className="num">{r.exit ?? '—'}</td>
                          <td style={{ maxWidth: 190 }}>
                            {r.dest != null ? (DEST_LABELS[r.dest] ?? `Code ${r.dest}`) : '—'}
                            {r.sub != null && (
                              <div className="bnl-sub" style={{ fontSize: 10.5 }}>
                                {SUBSIDY_LABELS[r.sub] ?? `Subsidy ${r.sub}`}
                              </div>
                            )}
                          </td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.los != null ? `${fmt(r.los)}d` : '—'}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.eps ?? '—'}</td>
                          <td className="num" style={{ textAlign: 'right',
                            color: r.s6 != null && r.s6 >= 40 ? 'var(--danger)' : r.s6 != null && r.s6 >= 20 ? 'var(--warn)' : 'var(--muted)' }}>
                            {r.ret ? '—' : r.s6 != null ? `${Number(r.s6).toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {r.ret ? (
                              <b style={{ fontSize: 11.5, color: 'var(--danger)', whiteSpace: 'nowrap' }}
                                title="This return already happened — the score was the model's pre-return forecast">
                                ↩ returned{r.retd != null ? ` +${fmt(r.retd)}d` : ''}
                              </b>
                            ) : (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                                <span style={{ width: 48, height: 6, background: 'var(--hair)', borderRadius: 3, overflow: 'hidden' }}>
                                  <span style={{ display: 'block', height: '100%', width: `${Math.min(Math.max(r.score, 2), 100)}%`, background: c, borderRadius: 3 }} />
                                </span>
                                <b className="num" style={{ color: c }}>{Number(r.score).toFixed(1)}%</b>
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: r.ret ? 'var(--danger)' : c, whiteSpace: 'nowrap' }}>
                              {r.ret ? 'Returned' : r.bucket}
                            </span>
                          </td>
                          <td>
                            <button type="button" className="btn" style={{ fontSize: 11, padding: '2px 9px' }}
                              onClick={() => openDossier(r.pid)} disabled={dossierBusy === r.pid}>
                              {dossierBusy === r.pid ? '…' : 'View'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </div>
    </>
  );
}

/* ══════════════ ⏱️ Survival ══════════════ */

interface OutlierRow {
  pid: string; project_id: number; project: string; ptype: string;
  entry: string | null; days: number; med: number | null; over: number;
}

function SurvivalSection({ a }: { a: AnalyticsInsights }) {
  const sv = a.survival;
  const types = Object.values(sv?.types ?? {});
  const [outliers, setOutliers] = useState<{ asOf: string | null; scoped: boolean; rows: OutlierRow[] } | null>(null);
  const [outErr, setOutErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  useEffect(() => {
    let dead = false;
    fetch('/api/analytics/outliers')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!dead) setOutliers(j); })
      .catch((e: Error) => { if (!dead) setOutErr(e.message); });
    return () => { dead = true; };
  }, []);

  const shownOutliers = useMemo(() => {
    const rows = outliers?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!typeFilter || r.ptype === typeFilter) &&
      (!needle || r.pid.toLowerCase().includes(needle) || r.project.toLowerCase().includes(needle)));
  }, [outliers, q, typeFilter]);
  const outTypes = useMemo(
    () => [...new Set((outliers?.rows ?? []).map((r) => r.ptype))].sort(), [outliers]);

  if (!sv) {
    return (
      <div className="panel" style={{ padding: 24 }}>
        <p className="bnl-sub">
          The survival payload hasn&rsquo;t been loaded yet — run the pipeline&rsquo;s meta load
          (upsert --only meta) after the next refresh and this section fills in.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grouplabel">Kaplan-Meier survival curves
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          probability of remaining enrolled — left: any exit · right: exit to permanent housing (other exits censored)
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
        <div className="panel" style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Time to any exit</div>
          <div className="bnl-sub" style={{ marginBottom: 6 }}>how long clients remain enrolled before leaving</div>
          <KMChart curveKey="any" types={types.map((t) => ({ label: t.label, color: t.color, curve: t.curve_any ?? [] }))} />
        </div>
        <div className="panel" style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Time to permanent-housing exit</div>
          <div className="bnl-sub" style={{ marginBottom: 6 }}>how long before a client exits to PH</div>
          <KMChart curveKey="ph" types={types.map((t) => ({ label: t.label, color: t.color, curve: t.curve_ph ?? [] }))} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '10px 2px' }}>
        {types.map((t) => (
          <span key={t.label} className="bnl-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 3, background: t.color, display: 'inline-block', borderRadius: 2 }} />
            {t.label} (n={fmt(t.n)})
          </span>
        ))}
      </div>
      <p className="bnl-method" style={{ margin: '4px 0 14px' }}>
        This is <b>time-to-exit</b>, per program type — a different question from Deep Dive&rsquo;s
        Time to Housing (which clocks move-in for housing programs). SO contacts are typically
        same-day, so a 0d median there is expected; &ldquo;not reached&rdquo; means over half were
        still enrolled past 730 days.
      </p>

      <div className="grouplabel">Median days summary</div>
      <div className="panel" style={{ padding: 0 }}>
        <div className="scroll">
          <table className="hm">
            <thead>
              <tr>
                <th>Project type</th><th>Enrollments</th>
                <th>Any-exit rate</th><th>Median LoS (any exit)</th>
                <th>PH exit rate</th><th>Median to PH</th>
              </tr>
            </thead>
            <tbody>
              {(sv.table ?? []).map((r) => (
                <tr key={r.type}>
                  <td>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: r.color, display: 'inline-block', marginRight: 7 }} />
                    {r.label}
                  </td>
                  <td className="num">{fmt(r.n)}</td>
                  <td className="num">{pct1(r.exit_rate)}</td>
                  <td className="num">{r.median != null ? `${r.median}d` : <span className="bnl-sub">not reached</span>}</td>
                  <td className="num">{pct1(r.ph_rate)}</td>
                  <td className="num">{r.median_ph != null ? `${r.median_ph}d` : <span className="bnl-sub">not reached</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grouplabel" style={{ marginTop: 18 }}>⏰ Long-stay outliers — currently enrolled</div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <div className="bnl-sub" style={{ flex: 1, minWidth: 260 }}>
            Active clients enrolled longer than 1.5× their program type&rsquo;s median, no PH exit yet —
            {' '}{fmt(sv.outliers_agg?.total)} system-wide
            ({Object.entries(sv.outliers_agg?.by_type ?? {}).map(([k, n]) => `${k} ${fmt(n)}`).join(' · ') || '—'}).
            {outliers?.scoped && <> Showing <b>your agency&rsquo;s projects only</b>.</>}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID or program…"
            style={{ padding: '6px 10px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--surface)', color: 'var(--text)', width: 200 }} />
          <select className="fselect" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {outTypes.map((t) => <option key={t} value={t}>{typeAbbr(t)}</option>)}
          </select>
          <a className="btn" href="/api/analytics/outliers?format=csv"><IconDownload size={12} /> Export CSV</a>
        </div>
        {outErr && <p className="bnl-sub">Couldn&rsquo;t load the outlier list ({outErr}).</p>}
        {!outliers && !outErr && <p className="bnl-sub">Loading…</p>}
        {outliers && (
          shownOutliers.length === 0 ? (
            <p className="bnl-sub">
              {outliers.rows.length === 0
                ? 'No long-stay outliers among your projects.'
                : 'Nothing matches the current filter.'}
            </p>
          ) : (
            <>
              <div className="bnl-sub" style={{ marginBottom: 6 }}>
                Showing {fmt(Math.min(shownOutliers.length, 500))} of {fmt(shownOutliers.length)}
                {outliers.asOf ? ` · as of ${outliers.asOf}` : ''} · sorted by days enrolled
              </div>
              <div className="scroll" style={{ maxHeight: 440, overflowY: 'auto' }}>
                <table className="hm">
                  <thead>
                    <tr>
                      <th>Client ID</th><th>Program</th><th>Type</th><th>Entry</th>
                      <th style={{ textAlign: 'right' }}>Days enrolled</th>
                      <th style={{ textAlign: 'right' }}>Type median</th>
                      <th style={{ textAlign: 'right' }}>Over median</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownOutliers.slice(0, 500).map((r) => {
                      const overPct = r.med ? Math.round((r.days / r.med - 1) * 100) : null;
                      return (
                        <tr key={`${r.pid}-${r.project_id}-${r.entry}`}>
                          <td style={{ minWidth: 120 }}><CopyId id={r.pid} /></td>
                          <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.project}>{r.project}</td>
                          <td>{r.ptype}</td>
                          <td className="num">{r.entry ?? '—'}</td>
                          <td className="num" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(r.days)}d</td>
                          <td className="num" style={{ textAlign: 'right', color: 'var(--muted)' }}>{r.med != null ? `${r.med}d` : '—'}</td>
                          <td className="num" style={{ textAlign: 'right' }}>
                            {overPct != null && (
                              <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 9, marginRight: 6,
                                background: overPct > 200 ? 'var(--danger-light)' : 'var(--warn-light, var(--hair))',
                                color: overPct > 200 ? 'var(--danger)' : 'var(--warn)' }}>+{fmt(overPct)}%</span>
                            )}
                            +{fmt(r.over)}d
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </div>
    </>
  );
}

/* ══════════════ 🏠 Capacity ══════════════ */

function CapStatRow({ label, side, color }: { label: string; side: CapSide; color: string }) {
  const cap = side.beds ?? side.units ?? null;
  const act = side.active ?? side.hh_active ?? null;
  const avail = cap != null && act != null ? cap - act : null;
  const availColor = avail == null ? 'var(--muted)'
    : avail <= 0 ? 'var(--danger)'
      : avail <= Math.max(5, (cap ?? 0) * 0.1) ? 'var(--warn)' : 'var(--accent)';
  const pill = (k: string, v: React.ReactNode) => (
    <span className="bnl-sub" style={{ whiteSpace: 'nowrap' }}>{k} <b className="num" style={{ color: 'var(--text)' }}>{v}</b></span>
  );
  return (
    <div style={{ background: 'var(--surface2, var(--hair))', borderRadius: 8, padding: '7px 10px', marginBottom: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        {side.beds != null && pill('Beds', fmt(side.beds))}
        {side.units != null && pill('Units', fmt(side.units))}
        {act != null && pill(side.beds != null ? 'Active' : 'Active HH', fmt(act))}
        {avail != null && pill('Available', <span style={{ color: availColor }}>{avail > 0 ? fmt(avail) : '0 (full)'}</span>)}
        {side.avg_hh_size != null && pill('Avg HH size', side.avg_hh_size)}
        {pill('Now', <span style={{ color: occColor(side.occ_now) }}>{pct1(side.occ_now)}</span>)}
        {pill('+30d', pct1(side.proj_30))}
        {pill('+60d', pct1(side.proj_60))}
        {pill('+90d', pct1(side.proj_90))}
      </div>
      <div className="bnl-sub" style={{ marginTop: 3, fontSize: 10.5 }}>
        {side.entries_mo}/mo in · {side.exits_mo}/mo out · net {side.net_mo >= 0 ? '+' : ''}{side.net_mo}/mo
      </div>
    </div>
  );
}

function CapacitySection({ capacity }: { capacity: CapRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!capacity.length) {
    return <div className="panel" style={{ padding: 24 }}><p className="bnl-sub">No capacity payload loaded yet.</p></div>;
  }
  const badge = (occ: number | null) => {
    if (occ == null) return null;
    const [bg, fg, lbl] = occ >= 100
      ? ['var(--danger-light)', 'var(--danger)', '⚠ Over capacity']
      : occ >= 85 ? ['var(--hair)', 'var(--warn)', '⚡ High load']
        : ['var(--accent-light)', 'var(--accent)', '✓ Normal'];
    return <span style={{ fontSize: 11, fontWeight: 700, background: bg, color: fg, borderRadius: 9, padding: '2px 8px' }}>{lbl}</span>;
  };
  const openRow = capacity.find((r) => r.state === open);

  // Overview grouped bars: occ now / +30 / +60 / +90 per state, 100% reference.
  const OV_W = 1000, OV_H = 240, OV_L = 40, OV_R = 10, OV_T = 10, OV_B = 30;
  const maxOcc = Math.max(...capacity.flatMap((r) => [r.occ_now ?? 0, r.proj_30 ?? 0, r.proj_60 ?? 0, r.proj_90 ?? 0]), 110);
  const oy = (v: number) => OV_T + (OV_H - OV_T - OV_B) * (1 - v / maxOcc);
  const groupW = (OV_W - OV_L - OV_R) / capacity.length;

  return (
    <>
      <p className="bnl-method" style={{ marginTop: 0 }}>
        Current bed occupancy and 30/60/90-day projections from 6-month average entry/exit rates.
        <b> Active</b> = point-in-time enrollment count (no exit as of the data cutoff) — enrollments,
        not unique clients. Beds from HUD Inventory.csv active the same date; RRH uses rental-assistance
        slots, not physical beds, so it can legitimately exceed 100%.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
        {capacity.map((row) => (
          <div key={row.state} className="panel" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: row.color }}>{row.label}</span>
              {badge(row.occ_now)}
            </div>
            {row.adult && <CapStatRow label="🧑 Adults" side={row.adult} color={ADULT_COLOR} />}
            {row.family && <CapStatRow label="👨‍👩‍👧 Families" side={row.family} color={FAMILY_COLOR} />}
            <CapSpark row={row} />
            {(row.projects?.length ?? 0) > 0 && (
              <button type="button" className="btn" style={{ width: '100%', marginTop: 6, fontSize: 12 }}
                onClick={() => setOpen(open === row.state ? null : row.state)}>
                {open === row.state ? '▼ Hide' : '▶ View'} {row.projects!.length} programs
              </button>
            )}
          </div>
        ))}
      </div>

      {openRow && (
        <>
          <div className="grouplabel" style={{ marginTop: 16, color: openRow.color }}>
            {openRow.label} — program breakdown
          </div>
          <div className="panel" style={{ padding: 0 }}>
            <div className="scroll">
              <table className="hm">
                <thead>
                  <tr>
                    <th>Program</th>
                    <th style={{ textAlign: 'right' }}>🧑 Beds</th>
                    <th style={{ textAlign: 'right' }}>Active</th>
                    <th style={{ textAlign: 'right' }}>Avail</th>
                    <th style={{ textAlign: 'right' }}>Occ%</th>
                    <th style={{ textAlign: 'right' }}>+90d</th>
                    <th style={{ textAlign: 'right' }}>Net/mo</th>
                    <th style={{ textAlign: 'right' }}>👨‍👩‍👧 Units</th>
                    <th style={{ textAlign: 'right' }}>HH</th>
                    <th style={{ textAlign: 'right' }}>Occ%</th>
                    <th style={{ textAlign: 'right' }}>+90d</th>
                  </tr>
                </thead>
                <tbody>
                  {(openRow.projects ?? []).map((p) => {
                    const ad = p.adult; const f = p.family;
                    const avail = ad?.beds != null && ad.active != null ? ad.beds - ad.active : null;
                    return (
                      <tr key={p.name}>
                        <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>{p.name}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{ad?.beds != null ? fmt(ad.beds) : '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{ad?.active != null ? fmt(ad.active) : '—'}</td>
                        <td className="num" style={{ textAlign: 'right', color: avail != null && avail <= 0 ? 'var(--danger)' : undefined }}>
                          {avail != null ? fmt(avail) : '—'}
                        </td>
                        <td className="num" style={{ textAlign: 'right', color: occColor(ad?.occ_now) }}>{pct1(ad?.occ_now)}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{pct1(ad?.proj_90)}</td>
                        <td className="num" style={{ textAlign: 'right' }}>
                          {ad ? `${ad.net_mo >= 0 ? '+' : ''}${ad.net_mo}` : '—'}
                        </td>
                        <td className="num" style={{ textAlign: 'right' }}>{f?.units != null ? fmt(f.units) : '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{f?.hh_active != null ? fmt(f.hh_active) : '—'}</td>
                        <td className="num" style={{ textAlign: 'right', color: occColor(f?.occ_now) }}>{f ? pct1(f.occ_now) : '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{f ? pct1(f.proj_90) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="grouplabel" style={{ marginTop: 16 }}>System occupancy overview
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>current and projected utilization per program type</span>
      </div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <svg viewBox={`0 0 ${OV_W} ${OV_H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
          {[0, 25, 50, 75, 100].filter((v) => v <= maxOcc).map((v) => (
            <g key={v}>
              <line x1={OV_L} x2={OV_W - OV_R} y1={oy(v)} y2={oy(v)} stroke="var(--hair)" strokeWidth={1} />
              <text x={OV_L - 5} y={oy(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{v}%</text>
            </g>
          ))}
          <line x1={OV_L} x2={OV_W - OV_R} y1={oy(100)} y2={oy(100)} stroke="var(--danger)" strokeWidth={1.2} strokeDasharray="4 3" />
          {capacity.map((r, gi) => {
            const vals = [r.occ_now, r.proj_30, r.proj_60, r.proj_90];
            const opac = [0.95, 0.7, 0.5, 0.3];
            const bw = (groupW * 0.68) / 4;
            const x0 = OV_L + gi * groupW + groupW * 0.16;
            return (
              <g key={r.state}>
                {vals.map((v, k) => v != null && (
                  <rect key={k} x={x0 + k * bw} y={oy(Math.max(v, 0))} width={bw - 2}
                    height={Math.max(oy(0) - oy(Math.max(v, 0)), 1)} fill={r.color} opacity={opac[k]} rx={2}>
                    <title>{r.label} {['now', '+30d', '+60d', '+90d'][k]}: {v}%</title>
                  </rect>
                ))}
                <text x={OV_L + gi * groupW + groupW / 2} y={OV_H - 10} textAnchor="middle" fontSize={10.5} fill="var(--text)">{r.label}</text>
              </g>
            );
          })}
        </svg>
        <div className="bnl-sub" style={{ marginTop: 6 }}>
          Bars per type: now · +30d · +60d · +90d (fading) — dashed red line = 100% capacity.
        </div>
      </div>
    </>
  );
}

/* ══════════════ 🔮 Inflow ══════════════ */

const STATE_COLORS: Record<string, string> = {
  SO: '#f59e0b', ES: '#3b82f6', TH: '#8b5cf6', RRH: '#f97316', PSH: '#10b981',
};
const STATE_LABELS: Record<string, string> = {
  SO: 'Street Outreach', ES: 'Emergency Shelter', TH: 'Transitional Housing', RRH: 'Rapid Rehousing', PSH: 'PSH',
};

function InflowSection({ inflow }: { inflow: Inflow | null }) {
  if (!inflow) {
    return <div className="panel" style={{ padding: 24 }}><p className="bnl-sub">No inflow payload loaded yet.</p></div>;
  }
  const last3 = Math.round(inflow.total.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, inflow.total.length));
  const prev12 = inflow.total.length >= 13
    ? Math.round(inflow.total.slice(-13, -1).reduce((a, b) => a + b, 0) / 12) : null;
  const slope = inflow.slope_per_month;
  const nextMo = inflow.future_months[0] ?? 'next mo';

  const tile = (k: string, v: React.ReactNode, s?: string) => (
    <div className="hc-t"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>
  );

  return (
    <>
      <p className="bnl-method" style={{ marginTop: 0 }}>
        HUD SPM Measure 5: monthly new entries to homelessness with no prior ES/SH/TH/PH/RRH enrollment
        in the past 24 months — unduplicated, system-level. Two forecasts are shown <b>on purpose</b>:
        the weighted average tracks the recent level, the linear trend tracks direction; the honest
        read is between them.
      </p>

      <div className="hc-tiles" style={{ marginBottom: 14 }}>
        {tile('Last 3mo avg (M5)', fmtInt(last3))}
        {prev12 != null && tile('Prior 12mo avg', fmtInt(prev12))}
        {tile('Trend', <span style={{ color: Math.abs(slope) < 5 ? 'var(--muted)' : slope > 0 ? 'var(--danger)' : 'var(--accent)' }}>
          {Math.abs(slope) < 5 ? '≈ flat' : `${slope > 0 ? '▲' : '▼'} ${Math.abs(slope)}/mo`}
        </span>)}
        {tile(`Weighted forecast (${nextMo})`, fmtInt(inflow.wt_forecasts[0] ?? 0))}
        {tile(`Trend forecast (${nextMo})`, fmtInt(inflow.trend_forecasts[0] ?? 0))}
      </div>

      <div className="grouplabel">First-time homeless — monthly actuals + 3-month forecast (M5)</div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <InflowMainChart inflow={inflow} />
      </div>

      <div className="grouplabel" style={{ marginTop: 16 }}>Total new enrollments by program type
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          supplementary — all new enrollments (incl. returning clients), last {inflow.months.length} months
        </span>
      </div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <InflowStackChart inflow={inflow} />
      </div>
    </>
  );
}

/** '2024-08' → 'Aug 2024' for readouts (axis ticks keep the compact '24-08'). */
const fmtYm = (m: string) => {
  const r = /^(\d{4})-(\d{2})/.exec(m);
  return r ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+r[2] - 1]} ${r[1]}` : m;
};

/** M5 bars (actuals) + both dashed forecasts, with the shared hover readout. */
function InflowMainChart({ inflow }: { inflow: Inflow }) {
  const [ref, k] = useSvgScale(1000, 1000);
  const fs = AXIS_PX * k;
  const n = inflow.months.length + inflow.future_months.length;
  const maxV = Math.max(...inflow.total, ...inflow.wt_forecasts, ...inflow.trend_forecasts, 1);
  const yMax = Math.ceil(maxV / 100) * 100 || 100;
  const yT = [0, 0.25, 0.5, 0.75, 1].map((g) => yMax * g);
  const W = 1000, H = 280, L = yAxisWidth(yT.map((v) => fmtInt(v)), k), R = 12 * k, T = 12 * k, B = 46 * k;
  const x = (i: number) => L + (i + 0.5) * ((W - L - R) / n);
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const bw = ((W - L - R) / n) * 0.62;
  const lastIdx = inflow.total.length - 1;
  const linePath = (vals: number[]) => {
    const pts = [[lastIdx, inflow.total[lastIdx]], ...vals.map((v, j) => [inflow.months.length + j, v])] as [number, number][];
    return pts.map(([i, v], j) => `${j ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  };
  const allLabels = [...inflow.months, ...inflow.future_months].map((m) => m.slice(2));
  const { hov, handlers } = useHoverBand(n, W, L, R);
  const isFuture = hov != null && hov > lastIdx;
  const fi = hov != null ? hov - inflow.months.length : -1;
  // legend: swatch + label pairs laid out left→right at true pixel size
  const legend: { kind: 'bar' | 'wt' | 'tr'; label: string }[] = [
    { kind: 'bar', label: 'actual (M5)' }, { kind: 'wt', label: 'weighted avg' }, { kind: 'tr', label: 'linear trend' },
  ];
  let lx = L;
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        {...handlers}>
        {yT.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={k} />
            <text x={L - 6 * k} y={y(v) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)"
              className="num">{fmtInt(v)}</text>
          </g>
        ))}
        {inflow.total.map((v, i) => (
          <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(y(0) - y(v), 1)}
            fill="var(--primary)" opacity={hov === i ? 0.95 : 0.55} rx={2} />
        ))}
        <line x1={x(lastIdx) + bw / 2 + 2} x2={x(lastIdx) + bw / 2 + 2} y1={T} y2={H - B}
          stroke="var(--border-strong)" strokeWidth={k} strokeDasharray="2 3" />
        <path d={linePath(inflow.wt_forecasts)} fill="none" stroke="var(--accent)" strokeWidth={2 * k} strokeDasharray="6 4" />
        <path d={linePath(inflow.trend_forecasts)} fill="none" stroke="var(--warn)" strokeWidth={2 * k} strokeDasharray="3 3" />
        {isFuture && (
          <g pointerEvents="none">
            <line x1={x(hov!)} x2={x(hov!)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={k} />
            {inflow.wt_forecasts[fi] != null && (
              <circle cx={x(hov!)} cy={y(inflow.wt_forecasts[fi])} r={3.5 * k} fill="var(--accent)" stroke="var(--card)" strokeWidth={1.5 * k} />
            )}
            {inflow.trend_forecasts[fi] != null && (
              <circle cx={x(hov!)} cy={y(inflow.trend_forecasts[fi])} r={3.5 * k} fill="var(--warn)" stroke="var(--card)" strokeWidth={1.5 * k} />
            )}
          </g>
        )}
        {xTicks(allLabels, x, k, 12).map(({ i, anchor }) => (
          <text key={`${allLabels[i]}-${i}`} x={x(i)} y={H - 26 * k} textAnchor={anchor} fontSize={fs}
            fill="var(--muted)">{allLabels[i]}</text>
        ))}
        {legend.map(({ kind, label }) => {
          const x0 = lx; lx += (28 + label.length * 6.4 + 22) * k;
          const ly = H - 8 * k;
          return (
            <g key={kind}>
              {kind === 'bar'
                ? <rect x={x0} y={ly - 8 * k} width={14 * k} height={8 * k} fill="var(--primary)" opacity={0.55} rx={2 * k} />
                : <line x1={x0} x2={x0 + 20 * k} y1={ly - 4 * k} y2={ly - 4 * k}
                    stroke={kind === 'wt' ? 'var(--accent)' : 'var(--warn)'} strokeWidth={2 * k}
                    strokeDasharray={kind === 'wt' ? '6 4' : '3 3'} />}
              <text x={x0 + 26 * k} y={ly} fontSize={fs} fill={kind === 'bar' ? 'var(--text)' : 'var(--muted)'}>{label}</text>
            </g>
          );
        })}
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
      </svg>
      {hov != null && (
        <div className="ctip" style={tipPos(x(hov) / W)}>
          <b>{fmtYm(isFuture ? inflow.future_months[fi] : inflow.months[hov])}</b>
          {isFuture ? (
            <>
              <span className="ctip-row"><i style={{ background: 'var(--accent)' }} />Weighted forecast
                <span className="num ctip-v">{fmtInt(inflow.wt_forecasts[fi] ?? 0)}</span></span>
              <span className="ctip-row"><i style={{ background: 'var(--warn)' }} />Trend forecast
                <span className="num ctip-v">{fmtInt(inflow.trend_forecasts[fi] ?? 0)}</span></span>
            </>
          ) : (
            <span className="ctip-row"><i style={{ background: 'var(--primary)' }} />First-time homeless
              <span className="num ctip-v">{fmtInt(inflow.total[hov])}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

/** New enrollments stacked by program type, hover = that month's breakdown. */
function InflowStackChart({ inflow }: { inflow: Inflow }) {
  const [ref, k] = useSvgScale(1000, 1000);
  const fs = AXIS_PX * k;
  const states = Object.keys(inflow.by_state ?? {});
  const stackTotals = inflow.months.map((m) => states.reduce((s, st) => s + (inflow.by_state[st]?.[m] ?? 0), 0));
  const sMax = Math.max(...stackTotals, 1);
  const yT = [0, 0.25, 0.5, 0.75, 1].map((g) => sMax * g);
  const W = 1000, SH = 260, L = yAxisWidth(yT.map((v) => fmtInt(v)), k), R = 12 * k, T = 12 * k, SB = 46 * k;
  const nM = inflow.months.length;
  const sy = (v: number) => T + (SH - T - SB) * (1 - v / sMax);
  const sx = (i: number) => L + (i + 0.5) * ((W - L - R) / nM);
  const sbw = ((W - L - R) / nM) * 0.66;
  const labels = inflow.months.map((m) => m.slice(2));
  const { hov, handlers } = useHoverBand(nM, W, L, R);
  const hRows = hov == null ? [] : states
    .map((st) => ({ st, v: inflow.by_state[st]?.[inflow.months[hov]] ?? 0 }))
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
  let lx = L;
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${SH}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        {...handlers}>
        {yT.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="var(--hair)" strokeWidth={k} />
            <text x={L - 6 * k} y={sy(v) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)"
              className="num">{fmtInt(v)}</text>
          </g>
        ))}
        {inflow.months.map((m, i) => {
          let acc = 0;
          return (
            <g key={m} opacity={hov == null || hov === i ? 1 : 0.55}>
              {states.map((st) => {
                const v = inflow.by_state[st]?.[m] ?? 0;
                if (!v) return null;
                const yTop = sy(acc + v); const yBot = sy(acc);
                acc += v;
                return (
                  <rect key={st} x={sx(i) - sbw / 2} y={yTop} width={sbw} height={Math.max(yBot - yTop, 0.5)}
                    fill={STATE_COLORS[st] ?? 'var(--muted)'} opacity={0.85} />
                );
              })}
            </g>
          );
        })}
        {xTicks(labels, sx, k, 12).map(({ i, anchor }) => (
          <text key={`${labels[i]}-${i}`} x={sx(i)} y={SH - 26 * k} textAnchor={anchor} fontSize={fs}
            fill="var(--muted)">{labels[i]}</text>
        ))}
        {states.map((st) => {
          const label = STATE_LABELS[st] ?? st;
          const x0 = lx; lx += (16 + label.length * 6.4 + 22) * k;
          const ly = SH - 8 * k;
          return (
            <g key={st}>
              <rect x={x0} y={ly - 8 * k} width={10 * k} height={8 * k} fill={STATE_COLORS[st] ?? 'var(--muted)'} rx={2 * k} />
              <text x={x0 + 15 * k} y={ly} fontSize={fs} fill="var(--muted)">{label}</text>
            </g>
          );
        })}
        <rect x={L} y={T} width={W - L - R} height={SH - T - SB} fill="transparent" />
      </svg>
      {hov != null && (
        <div className="ctip" style={tipPos(sx(hov) / W)}>
          <b>{fmtYm(inflow.months[hov])}</b>
          {hRows.map(({ st, v }) => (
            <span key={st} className="ctip-row">
              <i style={{ background: STATE_COLORS[st] ?? 'var(--muted)' }} />{STATE_LABELS[st] ?? st}
              <span className="num ctip-v">{fmtInt(v)}</span>
            </span>
          ))}
          <span className="ctip-row ctip-total">Total
            <span className="num ctip-v">{fmtInt(stackTotals[hov])}</span></span>
        </div>
      )}
    </div>
  );
}
