'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapacitySimData, PathwayIntel } from '../../../lib/queries';
import { SimulatorSection } from './PathwaySections';

/**
 * Capacity scenario simulator (user 2026-10-01, approved mockup).
 *
 * "What happens to homelessness if we add or cut PSH units / RRH slots /
 * shelter beds / TH beds?" — a month-by-month people model whose rates are
 * calibrated from HMIS person-month transitions (capacity_sim_core.py, rides
 * in pathway_intel.markov.capacity). Capacity is the constraint: every
 * program's occupancy is held at its target and refilled each month from
 * the homeless pool in the observed source mix.
 *
 * simulateCapacity() MUST stay identical to capacity_sim_core.simulate() —
 * the page's numbers and the backtest shown on it come from the same math.
 *
 * The old routing what-if (SimulatorSection) stays available as the second
 * view — additive, per the user's standing "don't replace what we have".
 */

type Prog = 'PSH' | 'RRH' | 'TH' | 'ES';
const PROGS: Prog[] = ['PSH', 'RRH', 'TH', 'ES'];
type Stocks = Record<'PSH' | 'RRH' | 'TH' | 'ES' | 'U' | 'HOUSED' | 'OUT', number>;
interface SimMonth { homeless: number; unsheltered: number; sheltered: number; housing: number; lost: number;
  PSH: number; RRH: number; TH: number; ES: number }

export function simulateCapacity(p: CapacitySimData['params'], s0: Stocks, targets: Record<Prog, number>[],
  inflowMult = 1): SimMonth[] {
  const S: Record<string, number> = { ...s0 };
  const out: SimMonth[] = [];
  for (const tgt of targets) {
    let housedFlow = 0; let lost = 0;
    for (const P of PROGS) {
      const e = p.exit[P]; const x = S[P];
      S[P] -= x * (e.housed + e.out + e.homeless);
      S.HOUSED += x * e.housed; S.OUT += x * e.out; S.U += x * e.homeless;
      if (P === 'TH' || P === 'ES') { housedFlow += x * e.housed; lost += x * e.out; }
    }
    const u = S.U;
    S.U -= u * (p.u.housed + p.u.out);
    S.HOUSED += u * p.u.housed; S.OUT += u * p.u.out;
    housedFlow += u * p.u.housed; lost += u * p.u.out;
    const h = S.HOUSED; const o = S.OUT;
    S.HOUSED -= h * (p.housed.return + p.housed.age);
    S.OUT -= o * (p.out.return + p.out.age);
    S.U += h * p.housed.return + o * p.out.return + p.new_per_month * inflowMult;
    let placed = 0;
    for (const P of PROGS) {
      const need = tgt[P] - S[P];
      if (need < 0) { S[P] += need; S.U -= need; continue; }   // cut: people lose the bed/unit
      const shares = p.fill_src[P];
      let got = 0;
      for (const [src, sh] of Object.entries(shares)) {
        const take = Math.min(need * sh, S[src]); S[src] -= take; got += take;
        if ((P === 'PSH' || P === 'RRH') && (src === 'U' || src === 'ES' || src === 'TH')) placed += take;
      }
      for (const src of Object.keys(shares)) {
        if (got >= need - 1e-9) break;
        const take = Math.min(need - got, S[src]); S[src] -= take; got += take;
        if ((P === 'PSH' || P === 'RRH') && (src === 'U' || src === 'ES' || src === 'TH')) placed += take;
      }
      S[P] += got;
    }
    out.push({ homeless: S.U + S.ES + S.TH, unsheltered: S.U, sheltered: S.ES + S.TH,
      housing: housedFlow + placed, lost, PSH: S.PSH, RRH: S.RRH, TH: S.TH, ES: S.ES });
  }
  return out;
}

interface Scenario { psh: number; rrh: number; es: number; th: number; start: number; ramp: number; inf: number }
const ZERO: Scenario = { psh: 0, rrh: 0, es: 0, th: 0, start: 3, ramp: 6, inf: 0 };
const MONTHS = 24;

function run(c: CapacitySimData, sc: Scenario): SimMonth[] {
  const base = c.stocks;
  const add: Record<Prog, number> = {
    PSH: sc.psh * (c.hh_size.PSH ?? 1),
    RRH: sc.rrh * (c.hh_size.RRH ?? 1),
    ES: sc.es * (c.new_bed_use.ES ?? 1),
    TH: sc.th * (c.new_bed_use.TH ?? 1),
  };
  const targets = Array.from({ length: MONTHS }, (_, i) => {
    const m = i + 1;
    const f = m < sc.start ? 0 : Math.min(1, (m - sc.start + 1) / Math.max(sc.ramp, 1));
    return Object.fromEntries(PROGS.map((P) => [P, Math.max(0, base[P] + add[P] * f)])) as Record<Prog, number>;
  });
  return simulateCapacity(c.params, c.stocks, targets, 1 + sc.inf / 100);
}

const fmt = (v: number) => Math.round(v).toLocaleString();
const sgn = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`;
const ymLabel = (m: string) => {
  const r = /^(\d{4})-(\d{2})/.exec(m);
  return r ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+r[2] - 1]} ${r[1]}` : m;
};
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Small line chart: series over a shared month axis, hover readout. */
function LineChart({ months, series, H = 240, splitAt }: {
  months: string[]; H?: number; splitAt?: number;
  series: { label: string; color: string; values: (number | null)[]; dash?: string; width?: number }[];
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [k, setK] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { const w = es[0]?.contentRect.width; if (w) setK(1000 / w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hov, setHov] = useState<number | null>(null);
  const W = 1000; const fs = 11 * k;
  const vals = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const raw = Math.max(...vals, 1);
  const mag = 10 ** Math.floor(Math.log10(raw / 4));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((f) => f * mag).find((s) => s * 4 >= raw) ?? 10 * mag;
  const yMax = step * 4;
  const yT = [0, 1, 2, 3, 4].map((i) => i * step);
  const L = (fmt(yMax).length * 6.6 + 12) * k, R = 12 * k, T = 10 * k, B = 44 * k;
  const n = months.length;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(n - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const path = (v: (number | null)[]) => {
    let d = ''; let pen = false;
    v.forEach((val, i) => {
      if (val == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`; pen = true;
    });
    return d;
  };
  const tickIdx = Array.from(new Set([0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1]));
  let lx = L;
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        aria-label={series.map((s) => s.label).join(', ')}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const vx = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((vx - L) / (W - L - R)) * (n - 1));
          setHov(i < 0 || i > n - 1 ? null : i);
        }}
        onMouseLeave={() => setHov(null)}>
        {yT.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={k} />
            <text x={L - 6 * k} y={y(v) + fs * 0.35} textAnchor="end" fontSize={fs} fill="var(--muted)" className="num">{fmt(v)}</text>
          </g>
        ))}
        {splitAt != null && (
          <>
            <line x1={x(splitAt)} x2={x(splitAt)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={k} strokeDasharray="2 3" />
            <text x={x(splitAt) + 5 * k} y={T + fs} fontSize={fs} fill="var(--muted)">today →</text>
          </>
        )}
        {series.map((s) => (
          <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={(s.width ?? 2) * k}
            strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hov != null && <line x1={x(hov)} x2={x(hov)} y1={T} y2={H - B} stroke="var(--border-strong)" strokeWidth={k} />}
        {tickIdx.map((i, j) => (
          <text key={i} x={x(i)} y={H - 26 * k} fontSize={fs} fill="var(--muted)"
            textAnchor={j === 0 ? 'start' : j === tickIdx.length - 1 ? 'end' : 'middle'}>{ymLabel(months[i])}</text>
        ))}
        {series.map((s) => {
          const x0 = lx; lx += (30 + s.label.length * 6.4 + 22) * k;
          return (
            <g key={`lg-${s.label}`}>
              <line x1={x0} x2={x0 + 22 * k} y1={H - 10 * k} y2={H - 10 * k} stroke={s.color} strokeWidth={2 * k} strokeDasharray={s.dash} />
              <text x={x0 + 28 * k} y={H - 6 * k} fontSize={fs} fill="var(--text)">{s.label}</text>
            </g>
          );
        })}
      </svg>
      {hov != null && (
        <div className="ctip" style={hov / n > 0.6 ? { right: `calc(${(1 - x(hov) / W) * 100}% + 10px)` } : { left: `calc(${(x(hov) / W) * 100}% + 10px)` }}>
          <b>{ymLabel(months[hov])}</b>
          {series.filter((s) => s.values[hov] != null).map((s) => (
            <span key={s.label} className="ctip-row"><i style={{ background: s.color }} />{s.label}
              <span className="num ctip-v">{fmt(s.values[hov]!)}</span></span>
          ))}
        </div>
      )}
    </div>
  );
}

const SAVE_KEY = 'capsim-saved';

function CapacitySimSection({ c }: { c: CapacitySimData }) {
  const [sc, setSc] = useState<Scenario>(ZERO);
  const [saved, setSaved] = useState<{ name: string; sc: Scenario }[]>([]);
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '[]'); if (Array.isArray(v)) setSaved(v); } catch { /* ignore */ }
  }, []);
  const persist = (v: { name: string; sc: Scenario }[]) => {
    setSaved(v);
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
  };

  const base = useMemo(() => run(c, { ...ZERO }), [c]);
  const sim = useMemo(() => run(c, sc), [c, sc]);
  const sum = (a: SimMonth[], key: 'housing' | 'lost') => a.reduce((s, m) => s + m[key], 0);
  const last = MONTHS - 1;
  const d = (key: 'homeless' | 'unsheltered' | 'sheltered') => sim[last][key] - base[last][key];
  const dHousing = sum(sim, 'housing') - sum(base, 'housing');
  const dLost = sum(sim, 'lost') - sum(base, 'lost');
  const changed = sc.psh || sc.rrh || sc.es || sc.th || sc.inf;

  const histMonths = c.history.map((h) => h.month);
  const futMonths = Array.from({ length: MONTHS }, (_, i) => addMonths(c.month, i + 1));
  const months = [...histMonths, ...futMonths];
  const pad = (arr: number[], before: number, joinVal?: number) =>
    [...Array(before - 1).fill(null), joinVal ?? null, ...arr];

  const name = (s: Scenario) => [
    s.psh && `${sgn(s.psh)} PSH units`, s.rrh && `${sgn(s.rrh)} RRH units`,
    s.es && `${sgn(s.es)} shelter beds`, s.th && `${sgn(s.th)} TH beds`,
    s.inf && `new homelessness ${s.inf > 0 ? '+' : ''}${s.inf}%`,
  ].filter(Boolean).join(' · ') || 'No change';

  const slider = (key: keyof Scenario, label: string, min: number, max: number, stepv: number, suffix?: string, note?: string) => (
    <div style={{ margin: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12.5 }}>
        <span style={{ flex: 1 }}>{label}</span>
        <b className="num" style={{ color: sc[key] && !['start', 'ramp'].includes(key) ? 'var(--primary)' : undefined }}>
          {['start', 'ramp'].includes(key) ? sc[key] : `${sc[key] > 0 ? '+' : ''}${sc[key]}${suffix ?? ''}`}
        </b>
      </div>
      <input type="range" min={min} max={max} step={stepv} value={sc[key]} aria-label={label}
        onChange={(e) => setSc((p) => ({ ...p, [key]: Number(e.target.value) }))}
        style={{ width: '100%', accentColor: 'var(--primary)' }} />
      {note && <div className="bnl-sub" style={{ fontSize: 11 }}>{note}</div>}
    </div>
  );

  const tile = (k: string, v: React.ReactNode, s?: React.ReactNode) => (
    <div className="hc-t"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>
  );
  const delta = (v: number, goodWhenDown: boolean) => (
    <span style={{ color: Math.abs(v) < 1 ? 'var(--muted)' : (v < 0) === goodWhenDown ? 'var(--accent)' : 'var(--danger)' }}>
      {Math.abs(v) < 1 ? 'no change' : `${sgn(v)} vs no change`}
    </span>
  );
  const bt = c.backtest;

  return (
    <>
      <p className="bnl-method" style={{ marginTop: 0 }}>
        Change capacity and see what happens to homelessness over the next 24 months, compared with changing nothing.
        Rates come from how people actually moved through the system month to month over the last year; capacity is the
        limit — each program stays as full as it is today, and new units or beds are filled from the people who are
        homeless. <b>A planning estimate, not a forecast guarantee.</b>
      </p>
      <div className="hc-tiles" style={{ marginBottom: 12 }}>
        {tile('Model check (backtest)', `±${bt.mape_homeless_6}%`,
          `first 6 months, ${ymLabel(addMonths(bt.from, 1))}–${ymLabel(addMonths(bt.from, 6))}`)}
        {tile('Full 12-month backtest', `±${bt.mape_homeless}%`,
          <span title={`Unsheltered ±${bt.mape_unsheltered}% · sheltered ±${bt.mape_sheltered}%`}>
            sheltered ±{bt.mape_sheltered}% · unsheltered ±{bt.mape_unsheltered}%</span>)}
        {tile('Starting point', fmt(c.stocks.U + c.stocks.ES + c.stocks.TH),
          `homeless, ${ymLabel(c.month)} · ${fmt(c.stocks.U)} unsheltered`)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 320px) minmax(0, 1fr)', gap: 14 }}>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Change capacity</div>
          {slider('psh', 'PSH units', -500, 1000, 25, '', `1 unit ≈ ${c.hh_size.PSH} people · today ${fmt(c.stocks.PSH)} people housed`)}
          {slider('rrh', 'RRH units', -300, 600, 25, '', `1 unit ≈ ${c.hh_size.RRH} people · today ${fmt(c.stocks.RRH)} people housed`)}
          {slider('es', 'Shelter beds', -600, 800, 25, '', `new beds used at today's ${Math.round((c.new_bed_use.ES ?? 1) * 100)}% occupancy`)}
          {slider('th', 'TH beds', -300, 400, 25, '', `new beds used at today's ${Math.round((c.new_bed_use.TH ?? 1) * 100)}% occupancy`)}
          <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 14 }}>Timing and other levers</div>
          {slider('start', 'Starts in month', 1, 12, 1)}
          {slider('ramp', 'Months to fill the new capacity', 1, 12, 1)}
          {slider('inf', 'New homelessness (prevention / diversion)', -30, 30, 1, '%')}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn primary" disabled={!changed}
              onClick={() => persist([...saved.filter((x) => x.name !== name(sc)), { name: name(sc), sc }].slice(-8))}>
              Save scenario
            </button>
            <button type="button" className="btn" onClick={() => setSc(ZERO)}>Reset</button>
          </div>
        </div>

        <div>
          <div className="hc-tiles" style={{ marginBottom: 12 }}>
            {tile('Homeless at 24 months', fmt(sim[last].homeless), delta(d('homeless'), true))}
            {tile('Unsheltered at 24 months', fmt(sim[last].unsheltered), delta(d('unsheltered'), true))}
            {tile('Extra people moved into housing', sgn(dHousing), 'over 24 months vs no change')}
            {tile('Lost contact (went inactive)', sgn(dLost),
              <span title="Homeless people who stop being seen for 90+ days — not housed, just out of contact. Cutting shelter beds pushes this up.">over 24 months vs no change</span>)}
          </div>
          <div className="panel" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>People homeless — last 2 years and next 2 years</div>
            <LineChart months={months} splitAt={histMonths.length - 1} H={260} series={[
              { label: 'Actual', color: 'var(--muted)', values: [...c.history.map((h) => h.homeless), ...Array(MONTHS).fill(null)] },
              { label: 'No change', color: 'var(--muted)', dash: '6 4',
                values: pad(base.map((m) => m.homeless), histMonths.length, c.history[c.history.length - 1]?.homeless) },
              ...(changed ? [{ label: 'Scenario', color: 'var(--primary)', width: 2.5,
                values: pad(sim.map((m) => m.homeless), histMonths.length, c.history[c.history.length - 1]?.homeless) }] : []),
            ]} />
          </div>
          <div className="panel" style={{ padding: '14px 18px', marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>People moving into housing each month</div>
            <LineChart months={futMonths} H={200} series={[
              { label: 'No change', color: 'var(--muted)', dash: '6 4', values: base.map((m) => m.housing) },
              ...(changed ? [{ label: 'Scenario', color: 'var(--accent)', width: 2.5, values: sim.map((m) => m.housing) }] : []),
            ]} />
          </div>
        </div>
      </div>

      <div className="grouplabel" style={{ marginTop: 16 }}>Saved scenarios
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>kept in this browser · 24 months vs no change</span>
      </div>
      <div className="panel" style={{ padding: '12px 16px' }}>
        {saved.length ? (
          <table>
            <thead><tr><th>Scenario</th><th className="num">Homeless</th><th className="num">Unsheltered</th>
              <th className="num">Extra moved into housing</th><th className="num">Lost contact</th><th /></tr></thead>
            <tbody>
              {saved.map((x) => {
                const r = run(c, x.sc);
                return (
                  <tr key={x.name}>
                    <td><button type="button" className="tbtn" onClick={() => setSc(x.sc)} title="Load this scenario">{x.name}</button></td>
                    <td className="num">{sgn(r[last].homeless - base[last].homeless)}</td>
                    <td className="num">{sgn(r[last].unsheltered - base[last].unsheltered)}</td>
                    <td className="num">{sgn(sum(r, 'housing') - sum(base, 'housing'))}</td>
                    <td className="num">{sgn(sum(r, 'lost') - sum(base, 'lost'))}</td>
                    <td className="num"><button type="button" className="tbtn" aria-label={`Remove ${x.name}`}
                      onClick={() => persist(saved.filter((y) => y.name !== x.name))}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="bnl-sub">Set up a scenario and click Save to compare several side by side.</p>}
      </div>

      <p className="bnl-method" style={{ marginTop: 12 }}>
        <b>How it works.</b> Each month, everyone known to the system is in one place: PSH, RRH (moved in), TH, shelter
        or safe haven, or <b>unsheltered</b> (open outreach or waiting to move in, with a contact in the last 90 days — the
        By-Name List&rsquo;s active rule). From HMIS, the model learns how many people a month leave each program and where
        they go, how many unsheltered people find housing on their own or go inactive, how many housed people return,
        and how many new people arrive ({fmt(c.params.new_per_month)} a month). Programs refill from the homeless pool in
        the mix seen in the data. <b>Housing</b> = exits to permanent housing plus PSH/RRH move-ins from homelessness.
        <b> Backtest</b>: rates from the year ending {ymLabel(bt.from)} projected the following year; the first months
        tracked closely, then a jump in unsheltered contacts from April 2026 (not in the earlier data) took over. Treat
        results as direction and size, not exact counts.
      </p>
    </>
  );
}

export function SimulatorTabs({ pi }: { pi: PathwayIntel }) {
  const cap = pi.markov?.capacity ?? null;
  const [view, setView] = useState<'capacity' | 'routing'>(cap ? 'capacity' : 'routing');
  return (
    <>
      <div className="seg" role="tablist" aria-label="Simulator views" style={{ marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={view === 'capacity'} className={view === 'capacity' ? 'on' : undefined}
          onClick={() => setView('capacity')}>Capacity scenarios</button>
        <button type="button" role="tab" aria-selected={view === 'routing'} className={view === 'routing' ? 'on' : undefined}
          onClick={() => setView('routing')}>Routing what-if</button>
      </div>
      {view === 'capacity'
        ? (cap ? <CapacitySimSection c={cap} /> : (
          <div className="panel" style={{ padding: 20 }}>
            <p className="bnl-sub">Capacity scenarios fill in after the next refresh (generate_pathways.py → meta load).</p>
          </div>
        ))
        : <SimulatorSection pi={pi} />}
    </>
  );
}
