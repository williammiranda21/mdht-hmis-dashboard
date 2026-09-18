'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtInt } from '../../../lib/format';
import type { AnalyticsInsights, SystemForecast, TrendSeries } from '../../../lib/queries';

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

type Tab = 'trends' | 'risk' | 'survival' | 'capacity' | 'inflow';
const TAB_KEY = 'an-tab';

const fmt = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString());
const pct1 = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);

/* ══════════════ chart primitives ══════════════ */

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
  const W = 520, H = 185, L = 40, R = 8, T = 8, B = 22;
  const values = s.values ?? [];
  const fit = s.fit ?? [];
  const proj = s.proj ?? [];
  const lo = s.proj_lower ?? [];
  const hi = s.proj_upper ?? [];
  const nAct = values.length;
  const n = nAct + proj.length;
  const [y0, y1] = yDomain([...values, ...fit, ...lo, ...hi]);
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
  const fmtY = (v: number) => (pct ? `${Math.round(v * 10) / 10}%` : days ? `${Math.round(v)}d` : fmt(v));
  const allLabels = [...periods, ...(s.proj_labels ?? [])];
  const step = Math.max(1, Math.ceil(n / 7));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      {[0, 0.5, 1].map((g) => {
        const v = y0 + (y1 - y0) * g;
        return (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={1} />
            <text x={L - 5} y={y(v) + 3} textAnchor="end" fontSize={8.5} fill="var(--muted)">{fmtY(v)}</text>
          </g>
        );
      })}
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
      {allLabels.map((m, i) => (i % step === 0 || i === n - 1) && (
        <text key={`${m}-${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={8} fill="var(--muted)">{m}</text>
      ))}
    </svg>
  );
}

/** Multi-series line chart (per-type trends) with an external toggle set. */
function MultiLine({ series, periods, active, pct, days }: {
  series: { key: string; label: string; color: string; values: (number | null)[] }[];
  periods: string[]; active: Set<string>; pct?: boolean; days?: boolean;
}) {
  const W = 1000, H = 260, L = 42, R = 10, T = 10, B = 24;
  const shown = series.filter((s) => active.has(s.key));
  const [y0, y1] = yDomain(shown.flatMap((s) => s.values));
  const n = periods.length;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  const fmtY = (v: number) => (pct ? `${Math.round(v * 10) / 10}%` : days ? `${Math.round(v)}d` : fmt(v));
  const path = (vals: (number | null)[]) => {
    let d = ''; let started = false;
    vals.forEach((v, i) => {
      if (v == null) { started = false; return; }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    });
    return d;
  };
  const step = Math.max(1, Math.ceil(n / 10));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => {
        const v = y0 + (y1 - y0) * g;
        return (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={1} />
            <text x={L - 5} y={y(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{fmtY(v)}</text>
          </g>
        );
      })}
      {shown.map((s) => (
        <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={1.6} opacity={0.9} />
      ))}
      {periods.map((m, i) => (i % step === 0 || i === n - 1) && (
        <text key={`${m}-${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={8.5} fill="var(--muted)">{m}</text>
      ))}
    </svg>
  );
}

/** Kaplan-Meier step chart: P(still enrolled) over days 0–730, one line per type. */
function KMChart({ types, curveKey }: {
  types: { label: string; color: string; curve: { x: number; y: number }[] }[]; curveKey: string;
}) {
  const W = 520, H = 240, L = 40, R = 10, T = 8, B = 30;
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
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={curveKey}>
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={L} x2={W - R} y1={y(p)} y2={y(p)} stroke="var(--hair)" strokeWidth={1} />
          <text x={L - 5} y={y(p) + 3} textAnchor="end" fontSize={8.5} fill="var(--muted)">{Math.round(p * 100)}%</text>
        </g>
      ))}
      {[0, 90, 180, 365, 545, 730].map((d) => (
        <text key={d} x={x(d)} y={H - 14} textAnchor="middle" fontSize={8.5} fill="var(--muted)">{d}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 3} textAnchor="middle" fontSize={8.5} fill="var(--muted)">days since enrollment</text>
      {types.map((t) => (
        <path key={t.label} d={path(t.curve)} fill="none" stroke={t.color} strokeWidth={1.8} />
      ))}
    </svg>
  );
}

/** Click-to-copy hashed client ID (user 2026-09-18) — used by the outlier and
 *  risk tables. Clipboard API first, hidden-textarea fallback (county browsers
 *  behind Web Isolation have refused the async API before). */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = id;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch { return false; }
    };
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).then(done, () => { if (fallback()) done(); });
    } else if (fallback()) done();
  };
  return (
    <button type="button" onClick={copy} title="Click to copy ID"
      className="num"
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', fontSize: 11, textAlign: 'left', wordBreak: 'break-all',
        color: copied ? 'var(--accent)' : 'inherit',
        textDecoration: copied ? 'none' : 'underline dotted',
        textUnderlineOffset: 3 }}>
      {copied ? '✓ copied' : id}
    </button>
  );
}

/** Horizontal bar row (label · scaled bar · value) — shared across sections. */
function BarRow({ label, value, max, display, color, sub }: {
  label: string; value: number; max: number; display: string; color: string; sub?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
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
  const W = 460, H = 100, L = 34, R = 6, T = 6, B = 18;
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
  const step = Math.max(1, Math.ceil(n / 6));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      <line x1={L} x2={W - R} y1={y(100)} y2={y(100)} stroke="var(--danger)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
      <text x={L - 4} y={y(100) + 3} textAnchor="end" fontSize={8} fill="var(--muted)">100%</text>
      <path d={path(aHist)} fill="none" stroke={ADULT_COLOR} strokeWidth={1.8} />
      {lastA != null && (
        <path d={path([lastA, ...aFore], nH - 1)} fill="none" stroke={ADULT_COLOR} strokeWidth={1.8} strokeDasharray="5 3" />
      )}
      {hasFam && <path d={path(fHist)} fill="none" stroke={FAMILY_COLOR} strokeWidth={1.8} />}
      {hasFam && lastF != null && (
        <path d={path([lastF, ...fFore], nH - 1)} fill="none" stroke={FAMILY_COLOR} strokeWidth={1.8} strokeDasharray="5 3" />
      )}
      {labels.map((m, i) => (i % step === 0 || i === n - 1) && (
        <text key={`${m}-${i}`} x={x(i)} y={H - 6} textAnchor="middle" fontSize={7.5} fill="var(--muted)">{m}</text>
      ))}
    </svg>
  );
}

/* ══════════════ the view ══════════════ */

export default function AnalyticsView({ a, forecast }: { a: AnalyticsInsights; forecast: SystemForecast }) {
  const [tab, setTabState] = useState<Tab>('trends');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY) as Tab | null;
      if (saved && ['trends', 'risk', 'survival', 'capacity', 'inflow'].includes(saved)) setTabState(saved);
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
        <div className="seg" role="tablist" aria-label="Analytics sections">
          {([
            ['trends', '📈 Trend Projection'],
            ['risk', '⚠️ Return Risk'],
            ['survival', '⏱️ Survival'],
            ['capacity', '🏠 Capacity'],
            ['inflow', '🔮 Inflow'],
          ] as [Tab, string][]).map(([k, lbl]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k}
              className={tab === k ? 'on' : undefined} onClick={() => setTab(k)}>{lbl}</button>
          ))}
        </div>
      </div>

      {tab === 'trends' && <TrendsSection a={a} />}
      {tab === 'risk' && <RiskSection a={a} />}
      {tab === 'survival' && <SurvivalSection a={a} />}
      {tab === 'capacity' && <CapacitySection capacity={capacity} />}
      {tab === 'inflow' && <InflowSection inflow={inflow} />}
    </>
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
}
const TIER_COLOR: Record<string, string> = {
  'Low (<20%)': 'var(--accent)',
  'Moderate (20–40%)': 'var(--warn)',
  'Elevated (40–60%)': '#f97316',
  'High (>60%)': 'var(--danger)',
};

function RiskSection({ a }: { a: AnalyticsInsights }) {
  const m = a.risk.model;
  // Client return-risk list (user directive 2026-09-18) — agency-scoped by
  // the an:risk drill RLS, hashed IDs only. Hooks live above the early
  // return (rules of hooks).
  const [clients, setClients] = useState<{ asOf: string | null; scoped: boolean; rows: RiskClientRow[] } | null>(null);
  const [clErr, setClErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  useEffect(() => {
    let dead = false;
    fetch('/api/analytics/risk')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!dead) setClients(j); })
      .catch((e: Error) => { if (!dead) setClErr(e.message); });
    return () => { dead = true; };
  }, []);
  const shownClients = useMemo(() => {
    const rows = clients?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!tier || r.bucket === tier) &&
      (!needle || r.pid.toLowerCase().includes(needle) || r.project.toLowerCase().includes(needle)));
  }, [clients, q, tier]);

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
  const factors = (m.features ?? []).map((f, i) => ({ f, w: m.importances?.[i] ?? 0 }))
    .sort((x, y) => Math.abs(y.w) - Math.abs(x.w)).slice(0, 12);
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
        <b>How to read this:</b> each client who recently exited to permanent housing is scored 0–100%
        for probability of returning to homelessness within 2 years, from program type, length of stay,
        prior episodes, income at exit, household composition, and age. Use the elevated/high tiers to
        prioritize follow-up outreach — the client list below is scoped to your agency&rsquo;s projects
        and shows hashed record IDs, never names.
      </p>

      <div className="grouplabel">What drives returns to homelessness</div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <div className="bnl-sub" style={{ marginBottom: 8 }}>
          Model factor weights, strongest first — <span style={{ color: 'var(--danger)', fontWeight: 700 }}>red</span> raises
          return risk, <span style={{ color: 'var(--accent)', fontWeight: 700 }}>green</span> is protective.
          Learned from {fmt(m.train_n)} historical PH exits.
        </div>
        {factors.map(({ f, w }) => (
          <BarRow key={f} label={f} value={w} max={wMax}
            display={`${w >= 0 ? '+' : ''}${w.toFixed(2)}`}
            color={w >= 0 ? 'var(--danger)' : 'var(--accent)'} />
        ))}
      </div>

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
          <a className="btn" href="/api/analytics/risk?format=csv">⬇ Export CSV</a>
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
                      <th style={{ textAlign: 'right' }}>LOS</th>
                      <th style={{ textAlign: 'right' }}>Prior eps.</th>
                      <th style={{ textAlign: 'right' }}>Risk score</th>
                      <th style={{ textAlign: 'center' }}>Tier</th>
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
                          <td className="num" style={{ textAlign: 'right' }}>{r.los != null ? `${fmt(r.los)}d` : '—'}</td>
                          <td className="num" style={{ textAlign: 'right' }}>{r.eps ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                              <span style={{ width: 48, height: 6, background: 'var(--hair)', borderRadius: 3, overflow: 'hidden' }}>
                                <span style={{ display: 'block', height: '100%', width: `${Math.min(Math.max(r.score, 2), 100)}%`, background: c, borderRadius: 3 }} />
                              </span>
                              <b className="num" style={{ color: c }}>{Number(r.score).toFixed(1)}%</b>
                            </span>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: c, whiteSpace: 'nowrap' }}>{r.bucket}</span>
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
            {outTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <a className="btn" href="/api/analytics/outliers?format=csv">⬇ Export CSV</a>
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

  // Main chart: bars = actuals, dashed lines = the two forecast methods.
  const W = 1000, H = 280, L = 44, R = 12, T = 12, B = 40;
  const n = inflow.months.length + inflow.future_months.length;
  const maxV = Math.max(...inflow.total, ...inflow.wt_forecasts, ...inflow.trend_forecasts, 1);
  const yMax = Math.ceil(maxV / 100) * 100 || 100;
  const x = (i: number) => L + (i + 0.5) * ((W - L - R) / n);
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const bw = ((W - L - R) / n) * 0.62;
  const lastIdx = inflow.total.length - 1;
  const linePath = (vals: number[]) => {
    const pts = [[lastIdx, inflow.total[lastIdx]], ...vals.map((v, k) => [inflow.months.length + k, v])] as [number, number][];
    return pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  };
  const allLabels = [...inflow.months, ...inflow.future_months];
  const step = Math.max(1, Math.ceil(n / 14));

  // Stacked by-type chart.
  const states = Object.keys(inflow.by_state ?? {});
  const stackTotals = inflow.months.map((m) => states.reduce((s, st) => s + (inflow.by_state[st]?.[m] ?? 0), 0));
  const sMax = Math.max(...stackTotals, 1);
  const SH = 260, SB = 40;
  const sy = (v: number) => T + (SH - T - SB) * (1 - v / sMax);
  const sx = (i: number) => L + (i + 0.5) * ((W - L - R) / inflow.months.length);
  const sbw = ((W - L - R) / inflow.months.length) * 0.66;

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
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={y(yMax * g)} y2={y(yMax * g)} stroke="var(--hair)" strokeWidth={1} />
              <text x={L - 6} y={y(yMax * g) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{fmtInt(yMax * g)}</text>
            </g>
          ))}
          {inflow.total.map((v, i) => (
            <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(y(0) - y(v), 1)}
              fill="var(--primary)" opacity={0.55} rx={2}>
              <title>{inflow.months[i]}: {fmtInt(v)}</title>
            </rect>
          ))}
          <line x1={x(lastIdx) + bw / 2 + 2} x2={x(lastIdx) + bw / 2 + 2} y1={T} y2={H - B}
            stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 3" />
          <path d={linePath(inflow.wt_forecasts)} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />
          <path d={linePath(inflow.trend_forecasts)} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="3 3" />
          {allLabels.map((m, i) => (i % step === 0 || i === n - 1) && (
            <text key={`${m}-${i}`} x={x(i)} y={H - 22} textAnchor="middle" fontSize={8.5} fill="var(--muted)">{m.slice(2)}</text>
          ))}
          <g>
            <rect x={L} y={H - 12} width={14} height={8} fill="var(--primary)" opacity={0.55} rx={2} />
            <text x={L + 20} y={H - 5} fontSize={10} fill="var(--text)">actual (M5)</text>
            <line x1={L + 120} x2={L + 142} y1={H - 8} y2={H - 8} stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" />
            <text x={L + 148} y={H - 5} fontSize={10} fill="var(--muted)">weighted avg</text>
            <line x1={L + 260} x2={L + 282} y1={H - 8} y2={H - 8} stroke="var(--warn)" strokeWidth={2} strokeDasharray="3 3" />
            <text x={L + 288} y={H - 5} fontSize={10} fill="var(--muted)">linear trend</text>
          </g>
        </svg>
      </div>

      <div className="grouplabel" style={{ marginTop: 16 }}>Total new enrollments by program type
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          supplementary — all new enrollments (incl. returning clients), last {inflow.months.length} months
        </span>
      </div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <svg viewBox={`0 0 ${W} ${SH}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={sy(sMax * g)} y2={sy(sMax * g)} stroke="var(--hair)" strokeWidth={1} />
              <text x={L - 6} y={sy(sMax * g) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{fmtInt(sMax * g)}</text>
            </g>
          ))}
          {inflow.months.map((m, i) => {
            let acc = 0;
            return (
              <g key={m}>
                {states.map((st) => {
                  const v = inflow.by_state[st]?.[m] ?? 0;
                  if (!v) return null;
                  const yTop = sy(acc + v); const yBot = sy(acc);
                  acc += v;
                  return (
                    <rect key={st} x={sx(i) - sbw / 2} y={yTop} width={sbw} height={Math.max(yBot - yTop, 0.5)}
                      fill={STATE_COLORS[st] ?? 'var(--muted)'} opacity={0.85}>
                      <title>{m} · {STATE_LABELS[st] ?? st}: {fmtInt(v)}</title>
                    </rect>
                  );
                })}
                {(i % 2 === 0 || i === inflow.months.length - 1) && (
                  <text x={sx(i)} y={SH - 24} textAnchor="middle" fontSize={8.5} fill="var(--muted)">{m.slice(2)}</text>
                )}
              </g>
            );
          })}
          {states.map((st, k) => (
            <g key={st}>
              <rect x={L + k * 150} y={SH - 12} width={10} height={8} fill={STATE_COLORS[st] ?? 'var(--muted)'} rx={2} />
              <text x={L + k * 150 + 15} y={SH - 5} fontSize={10} fill="var(--muted)">{STATE_LABELS[st] ?? st}</text>
            </g>
          ))}
        </svg>
      </div>
    </>
  );
}
