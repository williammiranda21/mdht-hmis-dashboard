'use client';

import { useEffect, useMemo, useState } from 'react';
import { periodLabel, fmtInt } from '../../lib/format';

/* ── shapes returned by /api/project ─────────────────────────────────────── */
interface ProjRec {
  project_id: number;
  name: string | null;
  project_type: number | null;
  type_name: string | null;
  operating_start: string | null;
  operating_end: string | null;
}
interface HistRow {
  period: string;
  clients_served: number | null;
  leavers: number | null;
  exits_ph: number | null;
  ph_exit_rate: number | null;
  exits_unsub: number | null;
  unsub_rate: number | null;
  avg_los: number | null;
  is_partial: boolean | null;
  data: Record<string, unknown> | null;
  /* returns mode — counts only; every rate below is derived */
  total_ph_exits?: number | null;
  returns_lt6mo?: number | null;
  returns_6to12mo?: number | null;
  returns_13to24mo?: number | null;
  returns_2yr?: number | null;
}

export type PanelMode = 'snapshot' | 'returns';

/** rate = band / total_ph_exits × 100 — the single definition used by the
 *  Returns tab and apr_monthly_report.py. returns_metrics stores no rates. */
const rate = (band: number | null | undefined, exits: number | null | undefined): number | null =>
  band == null || !exits ? null : (band / exits) * 100;
interface PeerRow {
  project_id: number;
  ph_exit_rate: number | null;
  avg_los: number | null;
  unsub_rate: number | null;
  data: Record<string, unknown> | null;
  total_ph_exits?: number | null;
  returns_lt6mo?: number | null;
  returns_6to12mo?: number | null;
  returns_13to24mo?: number | null;
  returns_2yr?: number | null;
}

/** HUD destination codes → label, for the returns destination breakdown. */
const DEST: Record<string, string> = {
  '410': 'Rental, no subsidy', '411': 'Owned, no subsidy',
  '421': 'Owned, with subsidy', '422': 'Staying w/ family (perm)',
  '423': 'Staying w/ friends (perm)', '426': 'HOPWA PH', '435': 'Rental, with subsidy',
};

/** Linear-interpolated percentile — same formula as _percentile() in
 *  apr_monthly_report.py, so ranks match the static dashboard exactly. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const pctOrDash = (v: number | null): string => (v == null ? '—' : `${v.toFixed(1)}%`);
/** 20%+ two-year return rate is the flag threshold used on the Returns tab. */
const ret2Flagged = (h: HistRow | null): boolean => {
  const r = rate(h?.returns_2yr, h?.total_ph_exits);
  return r != null && r >= 20;
};

interface PeerMetric {
  key: string;
  label: string;
  unit: string;
  /** Rank 1 = best. Avg LOS is the one where lower wins. */
  higherBetter: boolean;
  /** Lives inside the `data` jsonb rather than as its own column. */
  fromData?: boolean;
  /** A returns COUNT that must be divided by total_ph_exits to become a rate. */
  derived?: boolean;
}

const METRICS: PeerMetric[] = [
  { key: 'ph_exit_rate', label: 'PH Exit Rate', unit: '%', higherBetter: true },
  { key: 'avg_los', label: 'Avg LOS', unit: 'd', higherBetter: false },
  { key: 'unsub_rate', label: 'Unsub Rate', unit: '%', higherBetter: true },
  { key: 'EarnedIncomeImprovementRate', label: 'Income Impr.', unit: '%', higherBetter: true, fromData: true },
];

/** Returns benchmarking. Every metric is a RETURN rate, so lower is better
 *  throughout — the opposite of the snapshot panel. */
const RET_METRICS: PeerMetric[] = [
  { key: 'returns_lt6mo', label: 'Returns <6 mo', unit: '%', higherBetter: false, derived: true },
  { key: 'returns_6to12mo', label: 'Returns 6–12 mo', unit: '%', higherBetter: false, derived: true },
  { key: 'returns_13to24mo', label: 'Returns 13–24 mo', unit: '%', higherBetter: false, derived: true },
  { key: 'returns_2yr', label: '2-year return rate', unit: '%', higherBetter: false, derived: true },
];

const LOS_BANDS = [
  { key: 'LOS_0_30', label: '0–30 days', color: 'var(--primary)' },
  { key: 'LOS_31_90', label: '31–90 days', color: 'var(--secondary)' },
  { key: 'LOS_91_180', label: '91–180 days', color: 'var(--warn)' },
  { key: 'LOS_181_365', label: '181–365 days', color: '#EA7317' },
  { key: 'LOS_365plus', label: '365+ days', color: 'var(--danger)' },
];

export default function ProjectPanel({
  projectId, granularity, period, household, subpopulation, onClose, mode = 'snapshot',
}: {
  projectId: number; granularity: string; period: string;
  household: string; subpopulation: string; onClose: () => void; mode?: PanelMode;
}) {
  const [proj, setProj] = useState<ProjRec | null>(null);
  const [history, setHistory] = useState<HistRow[] | null>(null);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [dest, setDest] = useState<Record<string, { exits: number; returns: number }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isRet = mode === 'returns';

  useEffect(() => {
    let live = true;
    setProj(null); setHistory(null); setErr(null); setDest(null);
    const qs = new URLSearchParams({
      project_id: String(projectId), granularity, period, household, subpopulation, mode,
    });
    fetch(`/api/project?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (!live) return;
        setProj(j.project); setHistory(j.history); setPeers(j.peers ?? []); setDest(j.dest ?? null);
      })
      .catch(() => { if (live) { setErr('Could not load this project.'); setHistory([]); } });
    return () => { live = false; };
  }, [projectId, granularity, period, household, subpopulation, mode]);

  const latest = useMemo(
    () => history?.find((h) => h.period === period) ?? history?.[history.length - 1] ?? null,
    [history, period],
  );

  /**
   * Trend series. Leading periods with no rate are dropped: a project can carry
   * rows from before the HMIS export window (a long-staying client whose
   * enrollment predates it), which stretched the axis back years before any
   * line could be drawn. Trimming to the first real value means the chart starts
   * where the data starts — per project, with no hard-coded date.
   */
  const trend = useMemo(() => {
    if (!history) return [];
    const val = (h: HistRow) => (isRet ? rate(h.returns_2yr, h.total_ph_exits) : h.ph_exit_rate);
    const first = history.findIndex((h) => val(h) != null);
    if (first < 0) return [];
    return history.slice(first)
      .filter((h) => val(h) != null)
      .map((h) => ({ ...h, _y: val(h)! }));
  }, [history, isRet]);

  const losTotal = useMemo(
    () => LOS_BANDS.reduce((s, b) => s + (num(latest?.data?.[b.key]) ?? 0), 0),
    [latest],
  );

  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bnl-modal pp-modal" id="pp-printable">
        <div className="pp-actions">
          {/* Print-to-PDF is a stylesheet, not a DOM clone: @media print hides the
              rest of the page and un-clips the scroll areas so the full history
              table prints. "Save as PDF" in the browser's print dialog. */}
          <button className="btn pp-noprint" onClick={() => window.print()}
            title="Opens the print dialog — choose “Save as PDF”">🖨 PDF</button>
          <button className="bnl-x pp-noprint" onClick={onClose}>✕</button>
        </div>

        {err && <div className="bnl-dq">{err}</div>}
        {!proj && !err && <div className="hc-none">Loading project…</div>}

        {proj && (
          <>
            <h3>{proj.name ?? `Project ${proj.project_id}`}</h3>
            <div className="bnl-sub" style={{ marginTop: 2 }}>
              {proj.type_name ?? '—'}
              {proj.operating_start && (
                <> · {proj.operating_start.slice(0, 7)} – {proj.operating_end ? proj.operating_end.slice(0, 7) : 'ongoing'}</>
              )}
              {isRet && <> · Returns detail</>}
            </div>

            {/* KPI row */}
            <div className="hc-tiles" style={{ marginTop: 14 }}>
              {isRet ? (
                <>
                  <div className="hc-t">
                    <div className="k">PH exits (2yr window)</div>
                    <div className="v">{fmtInt(latest?.total_ph_exits ?? 0)}</div>
                  </div>
                  <div className="hc-t">
                    <div className="k">Returns &lt;6 mo</div>
                    <div className="v">{pctOrDash(rate(latest?.returns_lt6mo, latest?.total_ph_exits))}</div>
                  </div>
                  <div className="hc-t">
                    <div className="k">2-year return rate</div>
                    {/* 20%+ is the flag threshold used on the Returns tab */}
                    <div className="v" style={ret2Flagged(latest) ? { color: 'var(--danger)' } : undefined}>
                      {pctOrDash(rate(latest?.returns_2yr, latest?.total_ph_exits))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="hc-t">
                    <div className="k">Clients ({periodLabel(period)})</div>
                    <div className="v">{fmtInt(latest?.clients_served ?? 0)}</div>
                  </div>
                  <div className="hc-t">
                    <div className="k">PH exit rate</div>
                    <div className="v">{latest?.ph_exit_rate != null ? `${latest.ph_exit_rate}%` : '—'}</div>
                  </div>
                  <div className="hc-t">
                    <div className="k">Avg LOS</div>
                    <div className="v">{latest?.avg_los != null ? `${latest.avg_los}d` : '—'}</div>
                  </div>
                </>
              )}
            </div>

            {/* Destination breakdown — returns mode only */}
            {isRet && dest && Object.keys(dest).length > 0 && (
              <>
                <div className="hc-sub">Returns by exit destination — {periodLabel(period)}</div>
                {Object.entries(dest)
                  .sort((a, b) => (b[1].exits ?? 0) - (a[1].exits ?? 0))
                  .map(([code, d]) => {
                    const r = rate(d.returns, d.exits);
                    return (
                      <div className="hc-row" key={code}>
                        <span className="hc-pill">{code}</span>
                        <div className="hc-bwrap">
                          <div className="hc-blab">
                            <span>{DEST[code] ?? `Destination ${code}`}</span>
                            <b>{d.returns}/{d.exits} ({r == null ? '—' : `${r.toFixed(1)}%`})</b>
                          </div>
                          <div className="hc-bar">
                            <i style={{
                              width: `${Math.min(100, r ?? 0)}%`,
                              background: (r ?? 0) >= 20 ? 'var(--danger)' : 'var(--warn)',
                            }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </>
            )}

            {/* Length-of-stay distribution — snapshot only */}
            {!isRet && losTotal > 0 && (
              <>
                <div className="hc-sub">Length of stay — {periodLabel(period)}</div>
                <div className="pp-losbar">
                  {LOS_BANDS.map((b) => {
                    const v = num(latest?.data?.[b.key]) ?? 0;
                    if (!v) return null;
                    const pct = (100 * v) / losTotal;
                    return (
                      <span key={b.key} style={{ width: `${pct}%`, background: b.color }}
                        title={`${b.label}: ${v.toLocaleString()} (${pct.toFixed(0)}%)`}>
                        {pct >= 7 ? `${pct.toFixed(0)}%` : ''}
                      </span>
                    );
                  })}
                </div>
                <div className="pp-loskey">
                  {LOS_BANDS.map((b) => {
                    const v = num(latest?.data?.[b.key]) ?? 0;
                    if (!v) return null;
                    return (
                      <span key={b.key}>
                        <i style={{ background: b.color }} />
                        {b.label}: {v.toLocaleString()} ({((100 * v) / losTotal).toFixed(0)}%)
                      </span>
                    );
                  })}
                </div>
              </>
            )}

            {/* Peer benchmarking */}
            <div className="hc-sub">
              Peer benchmarking — {isRet ? 'return rates, same project type' : 'same project type'}
            </div>
            <PeerBench proj={proj} latest={latest} peers={peers} period={period}
              metrics={isRet ? RET_METRICS : METRICS} />

            {/* Trend */}
            <div className="hc-sub">
              {isRet ? '2-year return rate' : 'PH exit rate'} — historical trend
            </div>
            {trend.length < 2 ? (
              <div className="hc-none">Not enough history to chart.</div>
            ) : (
              <Trend rows={trend} current={period} />
            )}

            {/* History table */}
            <div className="hc-sub">
              {isRet ? 'Returns history' : 'Performance history'} ({history?.length ?? 0} periods)
            </div>
            <div className="scroll pp-hist">
              <table className="bnl-table">
                <thead>
                  {isRet ? (
                    <tr>
                      <th>Period</th><th className="num">PH exits</th>
                      <th className="num">&lt;6 mo</th><th className="num">6–12 mo</th>
                      <th className="num">13–24 mo</th><th className="num">2yr returns</th>
                      <th className="num">2yr rate</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Period</th><th className="num">Clients</th><th className="num">Leavers</th>
                      <th className="num">→ PH</th><th className="num">PH rate</th>
                      <th className="num">Unsub rate</th><th className="num">Avg LOS</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {[...(history ?? [])].reverse().map((h) => {
                    const cur = h.period === period ? 'pp-cur' : undefined;
                    const label = (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {periodLabel(h.period)}{h.is_partial ? <span className="bnl-sub"> (partial)</span> : null}
                      </td>
                    );
                    if (isRet) {
                      const r2 = rate(h.returns_2yr, h.total_ph_exits);
                      return (
                        <tr key={h.period} className={cur}>
                          {label}
                          <td className="num">{fmtInt(h.total_ph_exits ?? 0)}</td>
                          <td className="num">{fmtInt(h.returns_lt6mo ?? 0)}</td>
                          <td className="num">{fmtInt(h.returns_6to12mo ?? 0)}</td>
                          <td className="num">{fmtInt(h.returns_13to24mo ?? 0)}</td>
                          <td className="num">{fmtInt(h.returns_2yr ?? 0)}</td>
                          <td className="num" style={(r2 ?? 0) >= 20 ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                            {pctOrDash(r2)}
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={h.period} className={cur}>
                        {label}
                        <td className="num">{fmtInt(h.clients_served ?? 0)}</td>
                        <td className="num">{fmtInt(h.leavers ?? 0)}</td>
                        <td className="num">{fmtInt(h.exits_ph ?? 0)}</td>
                        <td className="num">{h.ph_exit_rate != null ? `${h.ph_exit_rate}%` : '—'}</td>
                        <td className="num">{h.unsub_rate != null ? `${h.unsub_rate}%` : '—'}</td>
                        <td className="num">{h.avg_los != null ? `${h.avg_los}d` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── peer benchmarking rows ──────────────────────────────────────────────── */
function PeerBench({
  proj, latest, peers, period, metrics,
}: {
  proj: ProjRec; latest: HistRow | null; peers: PeerRow[];
  period: string; metrics: PeerMetric[];
}) {
  const others = peers.filter((p) => p.project_id !== proj.project_id);
  if (others.length < 2) {
    return <div className="hc-none">Fewer than 2 peer projects with data — benchmarking not available.</div>;
  }

  const pick = (r: PeerRow | HistRow | null, m: PeerMetric): number | null => {
    if (!r) return null;
    const rec = r as unknown as Record<string, unknown>;
    // Returns metrics are stored as counts — convert to a rate before comparing,
    // or projects with more exits would look worse purely for being larger.
    if (m.derived) return rate(num(rec[m.key]), num(rec.total_ph_exits));
    return m.fromData ? num(r.data?.[m.key]) : num(rec[m.key]);
  };

  return (
    <>
      <div className="bnl-sub" style={{ marginBottom: 8 }}>
        {others.length} peer project{others.length === 1 ? '' : 's'} · {proj.type_name} · {periodLabel(period)}
      </div>
      {metrics.map((m) => {
        const vals = others.map((p) => pick(p, m)).filter((v): v is number => v != null).sort((a, b) => a - b);
        if (vals.length < 2) return null;
        const mine = pick(latest, m);
        const p25 = percentile(vals, 25)!, med = percentile(vals, 50)!, p75 = percentile(vals, 75)!;
        const vmin = vals[0], vmax = vals[vals.length - 1];
        const range = vmax - vmin || 1;
        const pct = (v: number) => Math.max(0, Math.min(100, ((v - vmin) / range) * 100));

        // Rank 1 = best, whichever direction is "good" for this metric.
        const rank = mine == null ? null
          : (m.higherBetter ? vals.filter((v) => v > mine).length : vals.filter((v) => v < mine).length) + 1;
        const better = mine != null && (m.higherBetter ? mine > med : mine < med);
        const worse = mine != null && (m.higherBetter ? mine < med : mine > med);

        return (
          <div className="peer-row" key={m.key}>
            <div className="peer-label">{m.label}</div>
            <div className="peer-track"
              title={`Min ${vmin}${m.unit} · P25 ${p25.toFixed(1)}${m.unit} · Median ${med.toFixed(1)}${m.unit} · P75 ${p75.toFixed(1)}${m.unit} · Max ${vmax}${m.unit}`}>
              <div className="peer-iqr" style={{ left: `${pct(p25)}%`, width: `${pct(p75) - pct(p25)}%` }} />
              <div className="peer-median" style={{ left: `${pct(med)}%` }} />
              {mine != null && (
                <div className={`peer-dot${better ? ' above-median' : worse ? ' below-median' : ''}`}
                  style={{ left: `${pct(mine)}%` }}
                  title={`This project: ${mine}${m.unit} · peer median ${med.toFixed(1)}${m.unit}`} />
              )}
            </div>
            <div className="peer-val">
              {mine != null ? `${mine}${m.unit}` : '—'}
              <span>{rank != null ? `#${rank} of ${vals.length + 1}` : ''}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── trend sparkline ─────────────────────────────────────────────────────── */
function Trend({ rows, current }: { rows: HistRow[]; current: string }) {
  const W = 1000, H = 210, L = 34, R = 10, T = 10, B = 30;
  const pts = rows.map((r, i) => {
    const x = L + (i * (W - L - R)) / Math.max(rows.length - 1, 1);
    const y = T + (H - T - B) * (1 - ((r as HistRow & { _y?: number })._y ?? r.ph_exit_rate ?? 0) / 100);
    return { x, y, r };
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${H - B} L${pts[0].x.toFixed(1)},${H - B} Z`;
  // ~8 labels max, always including the last period
  const step = Math.max(1, Math.ceil(rows.length / 8));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pp-trend" preserveAspectRatio="none">
      {[0, 25, 50, 75, 100].map((g) => {
        const y = T + (H - T - B) * (1 - g / 100);
        return (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--hair)" strokeWidth={1} />
            <text x={L - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{g}%</text>
          </g>
        );
      })}
      <path d={area} fill="var(--primary-soft)" />
      <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} />
      {pts.map((p) => (
        <circle key={p.r.period} cx={p.x} cy={p.y} r={p.r.period === current ? 4 : 2}
          fill={p.r.period === current ? 'var(--danger)' : 'var(--primary)'}>
          <title>{`${p.r.period}: ${p.r.ph_exit_rate}%`}</title>
        </circle>
      ))}
      {pts.map((p, i) => (i % step === 0 || i === pts.length - 1) && (
        <text key={`l${p.r.period}`} x={p.x} y={H - 10} textAnchor="middle" fontSize={9} fill="var(--muted)">
          {p.r.period}
        </text>
      ))}
    </svg>
  );
}
