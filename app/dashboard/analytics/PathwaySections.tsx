'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PathwayIntel, SankeyData, SankeyLink } from '../../../lib/queries';
import { CopyId, fmt, pct1 } from './shared';
import { IconClock, IconDownload } from '../../../components/icons';

/**
 * Pathway Intelligence — the four system tabs of the old static pathways page,
 * ported into the Analytics tab (user 2026-09-18): 🔀 Pathway Map ·
 * 🚧 Bottlenecks · 🎯 Housing Predictor · ⚙️ System Simulator.
 *
 * Aggregates come from meta.pathway_intel. The predictor's scored ACTIVE
 * clients come from /api/analytics/predictor (drill_clients `an:predict`,
 * agency-scoped by RLS, hashed IDs only). Dossier scoring (intervention
 * comparison, factor contributions) is weights × feature-vector arithmetic
 * done in the browser — same numbers the ETL produced, never re-derived.
 */

const fmtDays = (d: number | null | undefined) => {
  if (d == null) return null;
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${(d / 365).toFixed(1)} yr`;
};

/* ══════════════ 🔀 Pathway Map ══════════════ */

const COLS = [['SO'], ['ES', 'SH'], ['TH', 'RRH'], ['PSH'], ['Housed', 'Churned', 'Active']];
const COL_X = [80, 290, 500, 710, 880];
const COL_HDRS = ['Street\nOutreach', 'Emergency\nShelter / SH', 'Transitional /\nRapid Rehousing', 'Permanent\nSupportive', 'Outcomes'];

/** Nodes that can reach `target` following links (BFS over the full link set). */
function reachSet(links: SankeyLink[], target: string): Set<string> {
  const byTarget = new Map<string, string[]>();
  links.forEach((l) => {
    const arr = byTarget.get(l.target) ?? [];
    arr.push(l.source);
    byTarget.set(l.target, arr);
  });
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const t = queue.pop()!;
    for (const s of byTarget.get(t) ?? []) {
      if (!seen.has(s)) { seen.add(s); queue.push(s); }
    }
  }
  return seen;
}

function SankeyChart({ data, flow, clicked, onClickNode }: {
  data: SankeyData; flow: 'all' | 'housed' | 'churned';
  clicked: string | null; onClickNode: (id: string) => void;
}) {
  const W = 1100, H = 560, COL_W = 22;

  const model = useMemo(() => {
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));
    const srcVol: Record<string, number> = {}; const tgtVol: Record<string, number> = {};
    data.links.forEach((l) => {
      srcVol[l.source] = (srcVol[l.source] ?? 0) + l.value;
      tgtVol[l.target] = (tgtVol[l.target] ?? 0) + l.value;
    });
    const nodeVol: Record<string, number> = {};
    data.nodes.forEach((n) => {
      nodeVol[n.id] = Math.max(srcVol[n.id] ?? 0, tgtVol[n.id] ?? 0, n.n ?? 0);
    });
    const maxVol = Math.max(...Object.values(nodeVol), 1);
    const drawH = H - 90;
    const nodePos: Record<string, { x: number; y: number; h: number }> = {};
    COLS.forEach((col, ci) => {
      let totalH = col.reduce((s, id) => s + Math.max(18, (nodeVol[id] ?? 0) * drawH / maxVol), 0)
        + (col.length - 1) * 14;
      if (col.includes('Active')) totalH += 18;
      let y = (H - totalH) / 2;
      col.forEach((id) => {
        if (id === 'Active') y += 18;
        const h = Math.max(18, (nodeVol[id] ?? 0) * drawH / maxVol);
        nodePos[id] = { x: COL_X[ci], y, h };
        y += h + 14;
      });
    });

    // Flow filter — a link stays when its target is (or can reach) the outcome.
    let links = data.links.slice();
    if (flow !== 'all') {
      const target = flow === 'housed' ? 'Housed' : 'Churned';
      const canReach = reachSet(data.links, target);
      links = links.filter((l) => l.target === target || canReach.has(l.target));
    }
    links.sort((a, b) => b.value - a.value);
    const maxLink = Math.max(...links.map((l) => l.value), 1);

    const outOff: Record<string, number> = {}; const inOff: Record<string, number> = {};
    data.nodes.forEach((n) => { outOff[n.id] = 0; inOff[n.id] = 0; });
    const ribbons = links.map((l) => {
      const sp = nodePos[l.source]; const tp = nodePos[l.target];
      if (!sp || !tp) return null;
      const lw = Math.max(2, Math.round((l.value / maxLink) * 60));
      const x1 = sp.x + COL_W, x2 = tp.x;
      const y1 = sp.y + outOff[l.source], y2 = tp.y + inOff[l.target];
      outOff[l.source] += lw; inOff[l.target] += lw;
      const cx = (x1 + x2) / 2;
      const d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`
        + ` L${x2},${y2 + lw} C${cx},${y2 + lw} ${cx},${y1 + lw} ${x1},${y1 + lw} Z`;
      return { d, link: l, color: nodeMap.get(l.source)?.color ?? '#94a3b8' };
    }).filter((r): r is NonNullable<typeof r> => r != null);

    return { nodeMap, nodePos, nodeVol, ribbons };
  }, [data, flow]);

  const connected = useMemo(() => {
    const set = new Set<string>();
    if (clicked) {
      data.links.forEach((l) => {
        if (l.source === clicked || l.target === clicked) set.add(`${l.source}|${l.target}`);
      });
    }
    return set;
  }, [data, clicked]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 8 }} role="img">
      {model.ribbons.map(({ d, link, color }) => {
        const dimmed = clicked != null && !connected.has(`${link.source}|${link.target}`);
        if (dimmed) return null;
        return (
          <path key={`${link.source}-${link.target}`} d={d} fill={color} opacity={0.42} stroke="none">
            <title>
              {model.nodeMap.get(link.source)?.label ?? link.source} → {model.nodeMap.get(link.target)?.label ?? link.target}: {fmt(link.value)} clients
            </title>
          </path>
        );
      })}
      {Object.entries(model.nodePos).map(([id, pos]) => {
        const nd = model.nodeMap.get(id);
        if (!nd) return null;
        const isActive = id === 'Active';
        const isOutcome = ['Housed', 'Churned', 'Active'].includes(id);
        const cnt = fmt(model.nodeVol[id] ?? 0);
        const pctStr = !isOutcome && nd.ph_pct != null ? `${nd.ph_pct}% → PH` : '';
        return (
          <g key={id} style={{ cursor: 'pointer' }} onClick={() => onClickNode(id)}>
            {isActive && (
              <line x1={pos.x - 2} y1={pos.y - 10} x2={pos.x + COL_W + 2} y2={pos.y - 10}
                stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 2" />
            )}
            <rect x={pos.x} y={pos.y} width={COL_W} height={pos.h} rx={3}
              fill={nd.color ?? '#94a3b8'} opacity={isActive ? 0.45 : 1}
              stroke={clicked === id ? 'var(--text)' : 'none'} strokeWidth={2} />
            <text x={pos.x + COL_W + 6} y={pos.y + pos.h / 2 - 4}
              fill={isActive ? 'var(--muted)' : 'var(--text)'} fontStyle={isActive ? 'italic' : undefined}>
              <tspan x={pos.x + COL_W + 6} fontSize={11} fontWeight={500}>
                {nd.label.length > 20 ? `${nd.label.slice(0, 19)}…` : nd.label}
              </tspan>
              <tspan x={pos.x + COL_W + 6} dy={13} fontSize={10} fill="var(--muted)">
                {pctStr ? `${cnt} · ${pctStr}` : cnt}
              </tspan>
            </text>
            <title>
              {isOutcome
                ? `${nd.label}: ${cnt}${isActive ? ' — still enrolled, not a final outcome' : ''}`
                : `${nd.label}\n${cnt} enrollments · ${nd.ph_pct ?? '—'}% exited to permanent housing\nClick to isolate flows`}
            </title>
          </g>
        );
      })}
      {COL_X.map((cx, ci) => COL_HDRS[ci].split('\n').map((line, li) => (
        <text key={`${ci}-${li}`} x={cx + COL_W / 2} y={16 + li * 14} textAnchor="middle"
          fontSize={10} fontWeight={600} fill="var(--muted)">{line}</text>
      )))}
      {clicked && (
        <text x={W - 8} y={H - 6} textAnchor="end" fontSize={10} fill="var(--muted)">
          Showing flows for: {model.nodeMap.get(clicked)?.label ?? clicked} — click node again to reset
        </text>
      )}
    </svg>
  );
}

function PathChips({ path, colorMap }: { path: string; colorMap: Record<string, string> }) {
  const steps = path.split('→');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ background: colorMap[s] ?? '#94a3b8', color: '#fff', borderRadius: 4,
            padding: '1px 6px', fontSize: 10.5, fontWeight: 700 }}>{s}</span>
          {i < steps.length - 1 && <span style={{ color: 'var(--muted)', fontSize: 10 }}>→</span>}
        </span>
      ))}
    </span>
  );
}

function PathList({ paths, colorMap }: {
  paths: { path: string; n: number; median_days: number | null }[];
  colorMap: Record<string, string>;
}) {
  if (!paths?.length) return <p className="bnl-sub">No data for this filter</p>;
  const maxN = paths[0]?.n || 1;
  return (
    <>
      {paths.slice(0, 12).map(({ path, n, median_days }) => {
        const housed = path.endsWith('Housed');
        const dur = fmtDays(median_days);
        return (
          <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span style={{ width: Math.max(Math.round((n / maxN) * 100), 4), height: 8, borderRadius: 4,
              background: housed ? 'var(--accent)' : 'var(--muted)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}><PathChips path={path} colorMap={colorMap} /></span>
            {dur && (
              <span className="bnl-sub" title="Median time from first entry to outcome"
                style={{ fontSize: 10, whiteSpace: 'nowrap', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px' }}>
                <IconClock size={10} /> {dur}
              </span>
            )}
            <b className="num" style={{ fontSize: 12, flexShrink: 0 }}>{fmt(n)}</b>
          </div>
        );
      })}
    </>
  );
}

export function PathwaysSection({ pi }: { pi: PathwayIntel }) {
  const [period, setPeriod] = useState('all');
  const [hh, setHh] = useState('all');
  const [flow, setFlow] = useState<'all' | 'housed' | 'churned'>('all');
  const [clicked, setClicked] = useState<string | null>(null);
  const data = pi.sankey_filters?.[`${period}_${hh}`] ?? pi.sankey;
  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    data.nodes.forEach((n) => { m[n.id] = n.color; });
    return m;
  }, [data]);
  const vol = (id: string) => {
    const n = data.nodes.find((x) => x.id === id);
    return n?.n ?? 0;
  };
  const housed = vol('Housed'); const churned = vol('Churned'); const active = vol('Active');
  const total = housed + churned + active;

  return (
    <>
      <div className="grouplabel">Client pathway map
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          flow of clients between program types — ribbon width = volume · click a node to isolate its direct connections
        </span>
      </div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <select className="fselect" value={period} onChange={(e) => { setPeriod(e.target.value); setClicked(null); }}>
            {(pi.period_defs ?? []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
          <select className="fselect" value={hh} onChange={(e) => { setHh(e.target.value); setClicked(null); }}>
            {(pi.hh_defs ?? []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
          <div className="seg">
            {([['all', 'All flows'], ['housed', '→ Housed'], ['churned', '→ Left system']] as const).map(([k, lbl]) => (
              <button key={k} type="button" className={flow === k ? 'on' : undefined}
                onClick={() => { setFlow(k); setClicked(null); }}>{lbl}</button>
            ))}
          </div>
          <span className="bnl-sub">
            <b style={{ color: 'var(--text)' }}>{fmt(total)}</b> clients ·{' '}
            <b style={{ color: 'var(--accent)' }}>{fmt(housed)}</b> housed ({total ? ((housed / total) * 100).toFixed(1) : 0}%) ·{' '}
            {fmt(churned)} left · <span style={{ color: 'var(--info, #06b6d4)' }}>{fmt(active)} active</span>
          </span>
        </div>
        <SankeyChart data={data} flow={flow} clicked={clicked}
          onClickNode={(id) => setClicked(clicked === id ? null : id)} />
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
          {data.nodes.map((n) => (
            <span key={n.id} className="bnl-sub"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: n.id === 'Active' ? 0.6 : 1 }}>
              <span style={{ width: 11, height: 11, borderRadius: 2, background: n.color, display: 'inline-block' }} />
              {n.label}
              {!['Housed', 'Churned', 'Active'].includes(n.id) && n.ph_pct != null && <> ({n.ph_pct}% → PH)</>}
              {n.id === 'Active' && <em style={{ fontSize: 10 }}> † still enrolled</em>}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, marginTop: 14 }}>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Top pathways to housing</div>
          <div className="bnl-sub" style={{ marginBottom: 8 }}>most common sequences that reach permanent housing</div>
          <PathList paths={data.top_paths?.housed ?? []} colorMap={colorMap} />
        </div>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Top system-exit pathways</div>
          <div className="bnl-sub" style={{ marginBottom: 8 }}>most common sequences for clients who left without reaching PH</div>
          <PathList paths={data.top_paths?.churned ?? []} colorMap={colorMap} />
        </div>
      </div>
    </>
  );
}

/* ══════════════ 🚧 Bottlenecks ══════════════ */

function FlowRow({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '3px 0' }}>
      <span style={{ minWidth: 60, fontSize: 10, fontWeight: 600, color: 'var(--muted)' }}>{label}</span>
      <span style={{ flex: 1, height: 6, background: 'var(--hair)', borderRadius: 3, overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </span>
      <span className="num" style={{ fontSize: 10, color: 'var(--muted)', minWidth: 34, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

function MiniSpark({ vals, color }: { vals: (number | null)[]; color: string }) {
  const valid = vals.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v != null);
  if (valid.length < 2) return <svg width={80} height={24} />;
  const minV = Math.min(...valid.map((x) => x.v)); const maxV = Math.max(...valid.map((x) => x.v));
  const range = maxV - minV || 1;
  const pts = valid.map((x) =>
    `${((x.i / (vals.length - 1)) * 80).toFixed(1)},${(24 - 2 - ((x.v - minV) / range) * 20).toFixed(1)}`).join(' ');
  const last = valid[valid.length - 1];
  return (
    <svg width={80} height={24} style={{ overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={((last.i / (vals.length - 1)) * 80).toFixed(1)} cy={(24 - 2 - ((last.v - minV) / range) * 20).toFixed(1)} r={2.5} fill={color} />
    </svg>
  );
}

const GROUP_LBL: React.CSSProperties = {
  margin: '10px 0 4px', fontSize: 10, fontWeight: 600, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '.05em',
};

export function BottleneckSection({ pi }: { pi: PathwayIntel }) {
  const bn = pi.bottleneck ?? {};
  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    (pi.sankey?.nodes ?? []).forEach((n) => { m[n.id] = n.color; });
    return m;
  }, [pi]);
  const mk = pi.markov;

  return (
    <>
      <div className="grouplabel">System bottleneck analysis
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          where clients stall, cycle, and drop out — and what happens next at each stage
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 14 }}>
        {Object.entries(bn).map(([s, d]) => {
          const phColor = d.ph_rate >= 50 ? 'var(--accent)' : d.ph_rate >= 25 ? 'var(--warn)' : 'var(--danger)';
          return (
            <div key={s} className="panel" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 5, background: d.color, display: 'inline-block' }} />
                  <span style={{ fontSize: 14.5, fontWeight: 700 }}>{d.label}</span>
                </span>
                <span style={{ color: phColor, fontSize: 13, fontWeight: 800 }}>{d.ph_rate}% → PH</span>
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                <span className="bnl-sub">Enrollments <b className="num" style={{ color: 'var(--text)' }}>{fmt(d.n)}</b></span>
                <span className="bnl-sub">Median LoS <b className="num" style={{ color: 'var(--text)' }}>{d.median_los}d</b></span>
                <span className="bnl-sub">Cycling <b className="num" style={{ color: d.cycling_pct > 30 ? 'var(--danger)' : d.cycling_pct > 15 ? 'var(--warn)' : 'var(--accent)' }}>{d.cycling_pct}%</b></span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--hair)', borderRadius: 6 }}>
                <MiniSpark vals={d.ph_trend ?? []} color={d.color} />
                <div>
                  <div className="bnl-sub" style={{ fontSize: 10 }}>Quarterly trend (2 yrs)</div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{d.ph_12mo}% <span className="bnl-sub">PH rate · last 12 mo</span></div>
                  {d.ph_delta != null && (
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: d.ph_delta >= 0 ? 'var(--accent)' : 'var(--danger)' }}>
                      {d.ph_delta >= 0 ? '▲' : '▼'} {Math.abs(d.ph_delta)}pp vs all-time avg
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 6 }}>
                <div>
                  {(d.incoming_steps?.length ?? 0) > 0 && <div style={GROUP_LBL}>Came from</div>}
                  {(d.incoming_steps ?? []).map((x) => (
                    <FlowRow key={x.from} label={x.from} pct={x.pct} color={colorMap[x.from] ?? '#94a3b8'} />
                  ))}
                </div>
                <div>
                  <div style={GROUP_LBL}>Cycling depth</div>
                  <FlowRow label="1× only" pct={d.cycling_dist.once} color="var(--accent)" />
                  <FlowRow label="2–3×" pct={d.cycling_dist.few} color="var(--warn)" />
                  <FlowRow label="4× +" pct={d.cycling_dist.many} color="var(--danger)" />
                </div>
                <div>
                  <div style={GROUP_LBL}>Go next</div>
                  {(d.next_steps ?? []).slice(0, 4).map((x) => (
                    <FlowRow key={x.to} label={x.to} pct={x.pct} color={colorMap[x.to] ?? '#94a3b8'} />
                  ))}
                </div>
              </div>

              {d.exit_tiers && d.exit_tiers.n_total > 0 && (
                <>
                  <div style={GROUP_LBL}>Non-PH exit destinations ({fmt(d.exit_tiers.n_total)} exits)</div>
                  <FlowRow label="Homeless" pct={d.exit_tiers.homeless.pct} color="var(--danger)" />
                  <FlowRow label="Institution" pct={d.exit_tiers.inst.pct} color="#f97316" />
                  <FlowRow label="Temp/informal" pct={d.exit_tiers.temp.pct} color="var(--warn)" />
                  <FlowRow label="Unknown" pct={d.exit_tiers.unknown.pct} color="var(--muted)" />
                </>
              )}

              {d.opportunity?.opp_5pp > 0 && (
                <div style={{ marginTop: 10, padding: '8px 10px', borderLeft: '3px solid var(--primary)',
                  background: 'var(--hair)', borderRadius: '0 6px 6px 0', fontSize: 11.5 }}>
                  💡 <b>Opportunity:</b> a 5pp PH-rate improvement ≈ <b>{fmt(d.opportunity.opp_5pp)} more households/yr</b>;
                  10pp ≈ {fmt(d.opportunity.opp_10pp)}.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {mk && (
        <>
          <div className="grouplabel" style={{ marginTop: 16 }}>Transition probability matrix
            <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
              % of clients leaving each program type that go to each next state (rows = from, cols = to)
            </span>
          </div>
          <div className="panel" style={{ padding: 0 }}>
            <div className="scroll">
              <table className="hm">
                <thead>
                  <tr>
                    <th>From \ To</th>
                    {mk.states.map((s, i) => (
                      <th key={s} style={{ textAlign: 'center' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: mk.colors[i], display: 'inline-block', marginRight: 5 }} />{s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mk.P_display.map((row, ri) => {
                    const maxInRow = Math.max(...row.probs.filter((v) => v < 99), 1);
                    return (
                      <tr key={row.state}>
                        <td>
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: mk.colors[ri], display: 'inline-block', marginRight: 6 }} />
                          <b>{row.state}</b>
                        </td>
                        {row.probs.map((p, ci) => {
                          if (p === 0) return <td key={ci} className="num" style={{ textAlign: 'center', color: 'var(--faint, var(--muted))' }}>—</td>;
                          const alpha = 0.15 + Math.min(1, p / maxInRow) * 0.65;
                          const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
                          return (
                            <td key={ci} className="num" style={{ textAlign: 'center',
                              background: `${mk.colors[ci]}${hex}`, fontWeight: p >= 20 ? 700 : 400 }}>
                              {p}%
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ══════════════ 🎯 Housing Predictor ══════════════ */

interface PredRow {
  pid: string; project_id: number; project: string; state: string;
  entry: string | null; los: number; eps: number; ph: number; minor: number; score: number;
}
interface PredDetail extends PredRow {
  age: number; src: string | null; feat: number[];
  hist: { s: string; e: string; x: string; l: number; ph: number }[] | null;
}

// Scalar labels carry the quantity's direction so green/red bars read
// unambiguously (e.g. green "Longer stay so far" = longer stays raise the
// housing probability). Binary flags stay plain.
const FEAT_LABELS = [
  'ES enrollment', 'SH enrollment', 'TH enrollment', 'RRH enrollment', 'PSH enrollment',
  'Longer stay so far', 'More prior episodes', 'Youth (18-24)', 'Older adult (55+)', 'Unknown age',
  'Family household', 'More prior housing exits', 'Disabling condition', 'Veteran',
];
// Hover explanations, index-aligned with FEAT_LABELS (2026-09-18 user ask).
const FEAT_TIPS = [
  'Currently enrolled in emergency shelter — program types measured against Street Outreach, the reference.',
  'Currently enrolled in Safe Haven (vs Street Outreach).',
  'Currently enrolled in Transitional Housing (vs Street Outreach).',
  'Currently enrolled in RRH (vs Street Outreach) — the strongest program factor, since an RRH exit IS housing.',
  'Currently enrolled in a PSH-type program without a move-in yet (vs Street Outreach).',
  'Days enrolled so far (bucketed). The strongest factor overall — placements take time, and staying engaged predicts eventually being housed.',
  'Prior enrollment spells (bucketed 0–3+). Deeper history makes this enrollment less likely to end in housing.',
  'Age 18–24 at entry — youth reach housing slightly more often.',
  'Age 55+ at entry — housing exits become less likely with age.',
  'Date of birth missing in the record.',
  'The household includes a minor — families reach housing more often than single adults.',
  'Previous exits to permanent housing (capped at 2) — clients who got housed before are likelier to again.',
  'HUD 3.08 disabling condition — lowers the probability; PSH prioritization exists for exactly this population.',
  'Veteran status — VA housing resources raise the odds.',
];
const STATE_FULL: Record<string, string> = {
  SO: 'Street Outreach', ES: 'Emergency Shelter', SH: 'Safe Haven',
  TH: 'Transitional Housing', RRH: 'Rapid Rehousing', PSH: 'Perm. Supportive Housing',
};

const computeScore = (feat: number[], w: number[]) => {
  let z = w[w.length - 1];
  for (let i = 0; i < feat.length; i++) z += feat[i] * w[i];
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
};
const interventionFeat = (feat: number[], newState: string) => {
  const f = [...feat];
  f[0] = newState === 'ES' ? 1 : 0;
  f[1] = newState === 'SH' ? 1 : 0;
  f[2] = newState === 'TH' ? 1 : 0;
  f[3] = newState === 'RRH' ? 1 : 0;
  f[4] = newState === 'PSH' ? 1 : 0;
  f[5] = 0.25; // LOS bucket 30–90d, normalized /4
  return f;
};
const scoreColor = (score: number) => {
  const p = Math.round(score * 100);
  if (p >= 60) return 'var(--accent)';
  if (p >= 35) return 'var(--warn)';
  return 'var(--danger)';
};

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const c = scoreColor(score);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <span style={{ flex: 1, height: 8, background: 'var(--hair)', borderRadius: 4, overflow: 'hidden', minWidth: 60 }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: c, borderRadius: 4 }} />
      </span>
      <b className="num" style={{ color: c, minWidth: 36, fontSize: 12 }}>{pct}%</b>
    </span>
  );
}

const PAGE_SIZE = 20;

export function PredictorSection({ pi, initialPid = null }: { pi: PathwayIntel; initialPid?: string | null }) {
  const pm = pi.predictor_ml;
  const [data, setData] = useState<{ asOf: string | null; scoped: boolean; rows: PredRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [proj, setProj] = useState('');
  const [hh, setHh] = useState('');
  // Sorting: the dropdown sets presets; clicking a column header sorts by it
  // (click again to flip). Both drive the same (col, dir) pair.
  const [sortCol, setSortCol] = useState<'score' | 'los' | 'eps' | 'project' | 'state'>('score');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(1);
  const clickSort = (c: typeof sortCol) => {
    if (sortCol === c) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortCol(c); setSortDir(c === 'project' || c === 'state' || c === 'score' ? 1 : -1); }
  };
  const arrow = (c: typeof sortCol) => (sortCol === c ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
  const TH_SORT: React.CSSProperties = { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };
  const sortPreset = sortCol === 'score' && sortDir === 1 ? 'score_asc'
    : sortCol === 'score' && sortDir === -1 ? 'score_desc'
      : sortCol === 'los' && sortDir === -1 ? 'los_desc'
        : sortCol === 'eps' && sortDir === -1 ? 'prior_desc' : '';
  const [dossier, setDossier] = useState<PredDetail | null>(null);
  const [dossierBusy, setDossierBusy] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    fetch('/api/analytics/predictor')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!dead) setData(j); })
      .catch((e: Error) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, []);

  const stateKeys = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.state))].sort(), [data]);
  const projects = useMemo(() => {
    const seen = new Map<number, string>();
    (data?.rows ?? []).forEach((r) => { if (!seen.has(r.project_id)) seen.set(r.project_id, r.project); });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const filtered = useMemo(() => {
    let rows = (data?.rows ?? []).slice();
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((r) => r.pid.toLowerCase().includes(needle) || r.project.toLowerCase().includes(needle));
    if (types.size) rows = rows.filter((r) => types.has(r.state));
    if (proj) rows = rows.filter((r) => String(r.project_id) === proj);
    if (hh === 'adult') rows = rows.filter((r) => !r.minor);
    if (hh === 'family') rows = rows.filter((r) => !!r.minor);
    const cmp: Record<typeof sortCol, (a: PredRow, b: PredRow) => number> = {
      score: (a, b) => a.score - b.score,
      los: (a, b) => a.los - b.los,
      eps: (a, b) => a.eps - b.eps,
      project: (a, b) => a.project.localeCompare(b.project),
      state: (a, b) => a.state.localeCompare(b.state),
    };
    rows.sort((a, b) => cmp[sortCol](a, b) * sortDir);
    return rows;
  }, [data, q, types, proj, hh, sortCol, sortDir]);

  useEffect(() => { setPage(1); }, [q, types, proj, hh, sortCol, sortDir]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openDossier = (pid: string) => {
    setDossierBusy(pid);
    fetch(`/api/analytics/predictor?pid=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { setDossier(j.client ?? null); setDossierBusy(null); })
      .catch(() => setDossierBusy(null));
  };
  // Deep link from the BNL drawer: prefilter to the client and open their dossier.
  useEffect(() => {
    if (initialPid) { setQ(initialPid); openDossier(initialPid); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPid]);

  return (
    <>
      <div className="grouplabel">Housing predictor
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          ML model over Miami-Dade HMIS history — probability each active client reaches permanent housing
        </span>
      </div>

      {pm && (
        <div className="panel" style={{ padding: '14px 18px', marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>What drives the housing score</div>
          <div className="bnl-sub" style={{ margin: '2px 0 8px' }}>
            Model coefficients, strongest first — <span style={{ color: 'var(--accent)', fontWeight: 700 }}>green</span> raises
            the probability of reaching permanent housing, <span style={{ color: 'var(--danger)', fontWeight: 700 }}>red</span> lowers
            it. Trained on {fmt(pm.n_trained)} completed enrollments{pm.model_label ? ` (${pm.model_label})` : ''}.
            Program-type factors are relative to Street Outreach.
          </div>
          {(() => {
            const ws = pm.weights.slice(0, FEAT_LABELS.length)
              .map((w, i) => ({ label: FEAT_LABELS[i] ?? `f${i}`, tip: FEAT_TIPS[i], w }))
              .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
            const max = Math.max(...ws.map((x) => Math.abs(x.w)), 1e-9);
            return ws.map(({ label, tip, w }) => (
              <div key={label} title={tip} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', cursor: 'help' }}>
                <span style={{ flex: '0 0 220px', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                <span style={{ flex: 1, height: 10, background: 'var(--hair)', borderRadius: 5, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', borderRadius: 5,
                    width: `${Math.max((Math.abs(w) / max) * 100, 1.5)}%`,
                    background: w >= 0 ? 'var(--accent)' : 'var(--danger)' }} />
                </span>
                <b className="num" style={{ flex: '0 0 60px', textAlign: 'right', fontSize: 12.5,
                  color: w >= 0 ? 'var(--accent)' : 'var(--danger)' }}>{w >= 0 ? '+' : ''}{w.toFixed(2)}</b>
              </div>
            ));
          })()}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID or program…"
          style={{ padding: '6px 10px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--surface)', color: 'var(--text)', width: 210 }} />
        {stateKeys.map((s) => (
          <button key={s} type="button" className="btn" title={STATE_FULL[s] ?? s}
            onClick={() => setTypes((prev) => {
              const next = new Set(prev);
              if (next.has(s)) next.delete(s); else next.add(s);
              return next;
            })}
            style={{ fontSize: 11.5, padding: '3px 9px', opacity: types.size === 0 || types.has(s) ? 1 : 0.4 }}>
            {s}
          </button>
        ))}
        <select className="fselect" value={proj} onChange={(e) => setProj(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All projects</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className="fselect" value={hh} onChange={(e) => setHh(e.target.value)}>
          <option value="">All households</option>
          <option value="adult">Adult only</option>
          <option value="family">Adult with children</option>
        </select>
        <select className="fselect" value={sortPreset} onChange={(e) => {
          const v = e.target.value;
          if (v === 'score_asc') { setSortCol('score'); setSortDir(1); }
          else if (v === 'score_desc') { setSortCol('score'); setSortDir(-1); }
          else if (v === 'los_desc') { setSortCol('los'); setSortDir(-1); }
          else if (v === 'prior_desc') { setSortCol('eps'); setSortDir(-1); }
        }}>
          {sortPreset === '' && <option value="" disabled hidden>Custom (column sort)</option>}
          <option value="score_asc">Lowest score first (most at-risk)</option>
          <option value="score_desc">Highest score first</option>
          <option value="los_desc">Longest stay</option>
          <option value="prior_desc">Most prior episodes</option>
        </select>
        <a className="btn" href="/api/analytics/predictor?format=csv"><IconDownload size={12} /> Export CSV</a>
        {pm && (
          <span className="bnl-sub" style={{ marginLeft: 'auto', border: '1px solid var(--border)', borderRadius: 12, padding: '3px 10px' }}>
            Model: {fmt(pm.n_trained)} clients · {(pm.accuracy * 100).toFixed(1)}% accuracy
          </span>
        )}
      </div>

      {dossier && pm && (
        <DossierPanel client={dossier} pm={pm} onClose={() => setDossier(null)} />
      )}

      <div className="panel" style={{ padding: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Active caseload — ranked by housing probability</span>
          <span className="bnl-sub">
            {data ? <>{fmt(filtered.length)} active clients{data.scoped && <> · <b>your agency&rsquo;s projects only</b></>}{data.asOf ? ` · as of ${data.asOf}` : ''}</> : err ? `couldn't load (${err})` : 'loading…'}
          </span>
        </div>
        <div className="scroll">
          <table className="hm">
            <thead>
              <tr>
                <th>Client ID</th>
                <th style={TH_SORT} onClick={() => clickSort('project')} title="Click to sort">Program{arrow('project')}</th>
                <th style={TH_SORT} onClick={() => clickSort('state')} title="Click to sort">Type{arrow('state')}</th>
                <th style={{ ...TH_SORT, textAlign: 'right' }} onClick={() => clickSort('los')} title="Click to sort">Days{arrow('los')}</th>
                <th style={{ ...TH_SORT, textAlign: 'right' }} onClick={() => clickSort('eps')} title="Click to sort">Prior eps.{arrow('eps')}</th>
                <th style={{ textAlign: 'center' }}>Family</th>
                <th style={{ ...TH_SORT, minWidth: 150 }} onClick={() => clickSort('score')} title="Click to sort">Housing score{arrow('score')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={`${r.pid}-${r.project_id}`}>
                  <td style={{ minWidth: 120 }}><CopyId id={r.pid} /></td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.project}>{r.project}</td>
                  <td>{r.state}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{fmt(r.los)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{r.eps}</td>
                  <td style={{ textAlign: 'center' }}>{r.minor ? '✓' : '–'}</td>
                  <td><ScoreBar score={r.score} /></td>
                  <td>
                    <button type="button" className="btn" style={{ fontSize: 11, padding: '2px 9px' }}
                      onClick={() => openDossier(r.pid)} disabled={dossierBusy === r.pid}>
                      {dossierBusy === r.pid ? '…' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)} style={{ fontSize: 12 }}>← Prev</button>
            <span className="bnl-sub">Page {page} of {fmt(totalPages)}</span>
            <button type="button" className="btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)} style={{ fontSize: 12 }}>Next →</button>
          </div>
        )}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary className="bnl-sub" style={{ cursor: 'pointer', fontWeight: 600, padding: '6px 0' }}>
          ▶ Program-level historical lookup
        </summary>
        <BucketLookup pi={pi} />
      </details>
    </>
  );
}

function DossierPanel({ client, pm, onClose }: {
  client: PredDetail; pm: NonNullable<PathwayIntel['predictor_ml']>; onClose: () => void;
}) {
  const w = pm.weights;
  const pct = Math.round(client.score * 100);
  const color = scoreColor(client.score);
  const contrib = client.feat.map((v, i) => ({ label: FEAT_LABELS[i] ?? `f${i}`, tip: FEAT_TIPS[i], val: w[i] * v }));
  const helping = contrib.filter((x) => x.val > 0).sort((a, b) => b.val - a.val).slice(0, 3);
  const hurting = contrib.filter((x) => x.val < 0).sort((a, b) => a.val - b.val).slice(0, 3);
  const losB = client.los < 30 ? 0 : client.los < 90 ? 1 : client.los < 180 ? 2 : client.los < 365 ? 3 : 4;
  const ageB = client.age < 0 ? 3 : client.age <= 24 ? 0 : client.age <= 54 ? 1 : 2;
  const bucket = pm.profile_buckets?.[`${client.state}_${losB}_${client.eps}_${ageB}_${client.minor}`];

  return (
    <div className="panel" style={{ padding: '14px 18px', borderLeft: `4px solid ${color}`, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}><CopyId id={client.pid} /></span>
            <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, color: '#fff',
              background: 'var(--primary)' }}>{client.state}</span>
            {client.src && <span className="bnl-sub">from {client.src}</span>}
          </div>
          <div className="bnl-sub">
            {client.project || '—'} · Entry {client.entry ?? '—'} · {fmt(client.los)} days enrolled · {client.minor ? 'Family' : 'Adult only'}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div className="num" style={{ fontSize: 38, fontWeight: 800, color, lineHeight: 1 }}>{pct}%</div>
          <div className="bnl-sub" style={{ marginTop: 2 }}>housing probability</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 14 }}>
        <div>
          <div style={GROUP_LBL}>Factors</div>
          {helping.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', margin: '4px 0' }}>Helping ↑</div>}
          {helping.map((x) => (
            <div key={x.label} title={x.tip} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 6px', background: 'var(--accent-light)', borderRadius: 4, margin: '3px 0', cursor: 'help' }}>
              <span>{x.label}</span><b className="num" style={{ color: 'var(--accent)' }}>+{x.val.toFixed(3)}</b>
            </div>
          ))}
          {hurting.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger)', margin: '6px 0 4px' }}>Hurting ↓</div>}
          {hurting.map((x) => (
            <div key={x.label} title={x.tip} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 6px', background: 'var(--danger-light)', borderRadius: 4, margin: '3px 0', cursor: 'help' }}>
              <span>{x.label}</span><b className="num" style={{ color: 'var(--danger)' }}>{x.val.toFixed(3)}</b>
            </div>
          ))}
          {bucket ? (
            <div className="bnl-sub" style={{ marginTop: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
              <b style={{ color: 'var(--text)' }}>{fmt(bucket.n)} similar clients historically</b> — {bucket.ph_rate}% housed
              {bucket.median_los_housed > 0 && <> · median {bucket.median_los_housed} days to housing</>}
            </div>
          ) : (
            <div className="bnl-sub" style={{ marginTop: 10 }}>No similar-client bucket with 5+ records.</div>
          )}
        </div>
        <div>
          <div style={GROUP_LBL}>Intervention comparison</div>
          <div className="bnl-sub" style={{ marginBottom: 6 }}>predicted score if moved to each program (at 30–90d LOS)</div>
          <table className="hm">
            <tbody>
              {['RRH', 'PSH', 'TH', 'ES'].map((s) => {
                const sc = computeScore(interventionFeat(client.feat, s), w);
                const cur = s === client.state;
                return (
                  <tr key={s} style={cur ? { background: 'var(--accent-light)' } : undefined}>
                    <td style={{ fontWeight: cur ? 700 : 400, width: 110 }}>{s}{cur ? ' (current)' : ''}</td>
                    <td><ScoreBar score={sc} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(client.hist?.length ?? 0) > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={GROUP_LBL}>Prior enrollment history</div>
          <table className="hm">
            <thead>
              <tr><th>Program</th><th>Entry</th><th>Exit</th><th style={{ textAlign: 'right' }}>LOS</th><th style={{ textAlign: 'center' }}>Outcome</th></tr>
            </thead>
            <tbody>
              {client.hist!.map((h, i) => (
                <tr key={i}>
                  <td>{h.s}</td>
                  <td className="num">{h.e}</td>
                  <td className="num">{h.x}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{h.l}d</td>
                  <td style={{ textAlign: 'center', fontWeight: 700, color: h.ph ? 'var(--accent)' : 'var(--muted)' }}>{h.ph ? 'PH' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button type="button" className="btn" onClick={onClose} style={{ marginTop: 10, fontSize: 12 }}>✕ Close</button>
    </div>
  );
}

function BucketLookup({ pi }: { pi: PathwayIntel }) {
  const pred = pi.predictor ?? {};
  const states = Object.keys(pred);
  const [state, setState] = useState(states[0] ?? '');
  const [dayIdx, setDayIdx] = useState(2);
  const d = pred[state];
  const bucket = d?.buckets?.[dayIdx];
  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    (pi.sankey?.nodes ?? []).forEach((n) => { m[n.id] = n.color; });
    return m;
  }, [pi]);
  if (!d) return null;
  const valid = (d.buckets ?? []).filter((b) => !b.too_few && b.ph_rate != null);
  const best = valid.length ? valid.reduce((a, b) => ((b.ph_rate ?? 0) > (a.ph_rate ?? 0) ? b : a)) : null;
  const statePaths = (pi.sankey?.top_paths?.housed ?? [])
    .filter((p) => p.path.startsWith(`${state}→`)).slice(0, 5);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select className="fselect" value={state} onChange={(e) => setState(e.target.value)}>
          {states.map((s) => <option key={s} value={s}>{pred[s].label}</option>)}
        </select>
        <select className="fselect" value={dayIdx} onChange={(e) => setDayIdx(Number(e.target.value))}>
          {['<30 days', '30–90 days', '90–180 days', '180–365 days', '365+ days'].map((l, i) => (
            <option key={l} value={i}>{l}</option>
          ))}
        </select>
      </div>
      {!bucket || bucket.too_few ? (
        <p className="bnl-sub">Insufficient historical data for this combination (fewer than 10 similar exits).</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          <div className="panel" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>PH exit rate — similar clients</div>
            <div className="bnl-sub">{fmt(bucket.n)} historical exits from {d.label} in {bucket.label}</div>
            <div className="num" style={{ fontSize: 40, fontWeight: 800, margin: '10px 0',
              color: (bucket.ph_rate ?? 0) >= 60 ? 'var(--accent)' : (bucket.ph_rate ?? 0) >= 35 ? 'var(--warn)' : 'var(--danger)' }}>
              {bucket.ph_rate}%
            </div>
            <div className="bnl-sub">exited to permanent housing</div>
            {best && (
              <div className="bnl-sub" style={{ marginTop: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
                {best.label !== bucket.label
                  ? <>Best window for {d.label}: <b style={{ color: 'var(--text)' }}>{best.label}</b> → {best.ph_rate}%</>
                  : <>This is the <b style={{ color: 'var(--text)' }}>optimal window</b> for {d.label}</>}
              </div>
            )}
          </div>
          <div className="panel" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Outcome breakdown</div>
            <div className="bnl-sub" style={{ marginBottom: 8 }}>based on {fmt(bucket.n)} similar completed enrollments</div>
            <FlowRow label="→ PH" pct={bucket.ph_rate ?? 0} color="var(--accent)" />
            <FlowRow label="Left" pct={Math.max(0, 100 - (bucket.ph_rate ?? 0))} color="var(--muted)" />
            <div className="bnl-sub" style={{ marginTop: 6 }}>
              {fmt(bucket.n_ph)} exited to PH · {fmt((bucket.n ?? 0) - (bucket.n_ph ?? 0))} did not
            </div>
          </div>
          <div className="panel" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Top paths to housing</div>
            <div className="bnl-sub" style={{ marginBottom: 8 }}>most common successful sequences from {d.label}</div>
            {statePaths.length
              ? statePaths.map((p) => (
                <div key={p.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                  <span style={{ flex: 1, minWidth: 0 }}><PathChips path={p.path} colorMap={colorMap} /></span>
                  <b className="num" style={{ fontSize: 12 }}>{fmt(p.n)}</b>
                </div>
              ))
              : <p className="bnl-sub">No path data for this type</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════ ⚙️ System Simulator ══════════════ */

function simulate(P: number[][], states: string[], init: number[], nSteps: number) {
  const hIdx = states.indexOf('Housed'); const cIdx = states.indexOf('Churned');
  let dist = [...init];
  const out: { housed: number; churned: number }[] = [];
  for (let step = 0; step < nSteps; step++) {
    const next = Array(dist.length).fill(0) as number[];
    dist.forEach((d, from) => {
      P[from].forEach((p, to) => { next[to] += d * p; });
    });
    dist = next;
    out.push({ housed: +(dist[hIdx] * 100).toFixed(2), churned: +(dist[cIdx] * 100).toFixed(2) });
  }
  return out;
}

export function SimulatorSection({ pi }: { pi: PathwayIntel }) {
  const mk = pi.markov;
  const [vals, setVals] = useState<number[]>(() => (mk?.sliders ?? []).map((s) => s.baseline));
  const [scenario, setScenario] = useState<{ housed: number; churned: number }[] | null>(null);
  if (!mk) return null;

  const run = () => {
    // Rebuild P with slider overrides — the changed cell takes its new value
    // and the REST of the row rescales to keep it row-stochastic (the old
    // page's exact semantics, applied slider by slider).
    const P = mk.P.map((row) => [...row]);
    mk.sliders.forEach((sl, i) => {
      const newVal = vals[i] / 100;
      P[sl.row][sl.col] = newVal;
      const othersSum = P[sl.row].reduce((a, v, j) => (j === sl.col ? a : a + v), 0);
      if (othersSum > 0) {
        const scale = (1 - newVal) / othersSum;
        P[sl.row] = P[sl.row].map((v, j) => (j === sl.col ? v : v * scale));
      }
    });
    setScenario(simulate(P, mk.states, mk.active_dist, 24));
  };
  const reset = () => {
    setVals(mk.sliders.map((s) => s.baseline));
    setScenario(null);
  };

  const baseline = mk.baseline_sim ?? [];
  const b12 = baseline[11]?.housed; const s12 = scenario?.[11]?.housed;
  const delta = b12 != null && s12 != null ? +(s12 - b12).toFixed(1) : null;

  // Projection chart (SVG line, 24 months, y 0–100%).
  const W = 1000, H = 280, L = 42, R = 12, T = 12, B = 34;
  const x = (i: number) => L + (i * (W - L - R)) / 23;
  const y = (v: number) => T + (H - T - B) * (1 - v / 100);
  const line = (vals2: number[]) => vals2.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  // Distribution bars.
  const DW = 460, DH = 200, DL = 40, DB = 34;
  const maxC = Math.max(...mk.active_counts, 1);
  const dy = (v: number) => 10 + (DH - 10 - DB) * (1 - v / maxC);
  const bw = (DW - DL - 10) / mk.states.length;

  return (
    <>
      <div className="grouplabel">System what-if simulator
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          adjust key transition rates and see projected housing outcomes for today&rsquo;s active caseload
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Adjust transition rates</div>
          <div className="bnl-sub" style={{ marginBottom: 12 }}>move sliders to model interventions — baseline shown beside each</div>
          {mk.sliders.map((sl, i) => (
            <div key={`${sl.from_state}-${sl.to_state}`} style={{ margin: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 3 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: sl.color, display: 'inline-block' }} />
                <span style={{ flex: 1 }}>{sl.label}</span>
                <b className="num">{vals[i]?.toFixed(1)}%</b>
                <span className="bnl-sub" style={{ fontSize: 10.5 }}>(base {sl.baseline}%)</span>
              </div>
              <input type="range" min={0} max={100} step={0.5} value={vals[i] ?? sl.baseline}
                onChange={(e) => setVals((prev) => prev.map((v, j) => (j === i ? Number(e.target.value) : v)))}
                style={{ width: '100%', accentColor: sl.color }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" className="btn primary" onClick={run}>Run simulation</button>
            <button type="button" className="btn" onClick={reset}>Reset</button>
          </div>
          {delta != null && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600,
              border: '1px solid var(--border)', color: delta > 0 ? 'var(--accent)' : delta < 0 ? 'var(--danger)' : 'var(--muted)' }}>
              At 12 months: {delta > 0 ? '+' : ''}{delta}pp vs baseline ({b12!.toFixed(1)}% → {s12!.toFixed(1)}% housed)
            </div>
          )}
        </div>

        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Active caseload distribution</div>
          <div className="bnl-sub" style={{ marginBottom: 8 }}>starting point — current enrolled clients by program type</div>
          <svg viewBox={`0 0 ${DW} ${DH}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
            {mk.states.map((s, i) => {
              const c = mk.active_counts[i] ?? 0;
              if (['Housed', 'Churned'].includes(s)) return null;
              return (
                <g key={s}>
                  <rect x={DL + i * bw + 4} y={dy(c)} width={bw - 8} height={Math.max(dy(0) - dy(c), 1)}
                    fill={mk.colors[i]} rx={3}>
                    <title>{s}: {fmt(c)} active clients</title>
                  </rect>
                  <text x={DL + i * bw + bw / 2} y={DH - 20} textAnchor="middle" fontSize={10} fill="var(--text)">{s}</text>
                  <text x={DL + i * bw + bw / 2} y={DH - 8} textAnchor="middle" fontSize={9} fill="var(--muted)">{fmt(c)}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className="grouplabel" style={{ marginTop: 16 }}>Projected housing outcomes — 24-month forward simulation
        <span className="bnl-sub" style={{ fontWeight: 400, marginLeft: 8 }}>
          % of today&rsquo;s active caseload projected to reach permanent housing (or leave the system)
        </span>
      </div>
      <div className="panel" style={{ padding: '14px 18px' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeWidth={1} />
              <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{v}%</text>
            </g>
          ))}
          {[0, 5, 11, 17, 23].map((i) => (
            <text key={i} x={x(i)} y={H - 20} textAnchor="middle" fontSize={9} fill="var(--muted)">Mo {i + 1}</text>
          ))}
          <path d={line(baseline.map((d) => d.housed))} fill="none" stroke="var(--accent)" strokeWidth={2} />
          <path d={line(baseline.map((d) => d.churned))} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="4 3" />
          {scenario && (
            <>
              <path d={line(scenario.map((d) => d.housed))} fill="none" stroke="var(--primary)" strokeWidth={2.5} />
              <path d={line(scenario.map((d) => d.churned))} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="4 3" />
            </>
          )}
          <g fontSize={10}>
            <line x1={L} x2={L + 20} y1={H - 6} y2={H - 6} stroke="var(--accent)" strokeWidth={2} />
            <text x={L + 25} y={H - 3} fill="var(--text)">baseline housed</text>
            <line x1={L + 130} x2={L + 150} y1={H - 6} y2={H - 6} stroke="var(--muted)" strokeWidth={2} strokeDasharray="4 3" />
            <text x={L + 155} y={H - 3} fill="var(--muted)">baseline churned</text>
            {scenario && (
              <>
                <line x1={L + 270} x2={L + 290} y1={H - 6} y2={H - 6} stroke="var(--primary)" strokeWidth={2.5} />
                <text x={L + 295} y={H - 3} fill="var(--text)">scenario housed</text>
                <line x1={L + 400} x2={L + 420} y1={H - 6} y2={H - 6} stroke="var(--warn)" strokeWidth={2} strokeDasharray="4 3" />
                <text x={L + 425} y={H - 3} fill="var(--muted)">scenario churned</text>
              </>
            )}
          </g>
        </svg>
      </div>
    </>
  );
}
