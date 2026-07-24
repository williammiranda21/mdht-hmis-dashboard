'use client';

import { useEffect, useMemo, useState } from 'react';
import { fmtInt } from '../../../lib/format';

/**
 * Project pathways — where a project's clients came from and went, traced across
 * the whole system. Renders `project_pathways`; nothing is computed here beyond
 * SVG layout.
 *
 * The diagram is a ONE-STEP transition Sankey, drawn bipartite on purpose: the
 * same programme appears once on the left (as a source) and again on the right
 * (as a destination). A conventional Sankey tangles here because clients cycle —
 * SO→ES and ES→SO both happen constantly — and a layout that tries to place each
 * state once ends up with loops that hide the volume. Bipartite keeps every flow
 * legible: "from each state my clients were in, where did they go next".
 */

interface PathNode { id: string; label: string; color: string; n: number; ph_pct: number | null }
interface PathLink { source: string; target: string; value: number }
interface TopPath { path: string; n: number; median_days: number | null; avg_days: number | null }
interface Tier { n: number; pct: number }
interface Bottleneck {
  label: string; color: string; n: number; n_ph: number; n_active: number; n_churned: number;
  ph_rate: number; active_rate: number; churn_rate: number; median_los: number;
  next_steps: { to: string; n: number; pct: number }[];
  exit_tiers: { homeless: Tier; inst: Tier; temp: Tier; unknown: Tier; n_total: number };
}
interface PathwayData {
  project_id: number; project_name: string | null; project_type: number | null;
  n_clients: number; window_start: string | null; window_end: string | null;
  data: {
    // before/after flow (per client) — drives the Sankey
    flow: { nodes: PathNode[]; links: PathLink[] };
    // full-journey context (per enrollment) — drives journeys + bottleneck
    nodes: PathNode[];
    top_paths: { all: TopPath[]; housed: TopPath[]; churned: TopPath[] };
    source_rates: Record<string, { total: number; ph: number; ph_pct: number }>;
    bottleneck: Record<string, Bottleneck>;
  };
}

const ORDER = ['SO', 'ES', 'SH', 'TH', 'RRH', 'PSH', 'Housed', 'Churned', 'Active'];
// The flow Sankey adds a leftmost "First entry" column for clients with no prior
// enrollment on record.
const FLOW_ORDER = ['First', ...ORDER];
const days = (n: number | null) => (n == null ? '—' : `${n.toLocaleString()}d`);

export default function ProjectPathways({
  projectIds, options,
}: { projectIds: number[]; options: { id: number; name: string; type: string }[] }) {
  const [pid, setPid] = useState<number | null>(projectIds[0] ?? null);
  const [data, setData] = useState<PathwayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [pathKind, setPathKind] = useState<'housed' | 'churned'>('housed');

  // Keep the picked project inside the current selection.
  useEffect(() => {
    if (pid == null || !projectIds.includes(pid)) setPid(projectIds[0] ?? null);
  }, [projectIds, pid]);

  useEffect(() => {
    if (!open || pid == null) return;
    let live = true;
    setLoading(true); setErr(null);
    fetch(`/api/pathways?project=${pid}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setData(j.pathways); })
      .catch(() => { if (live) setErr('Could not load pathways.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [pid, open]);

  const nameOf = useMemo(() => {
    const m = new Map<number, string>();
    options.forEach((o) => m.set(o.id, o.name));
    return m;
  }, [options]);

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h dd-head" role="button" tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}>
        <div>
          <h3>Client pathways</h3>
          <div className="meta">
            For the clients this project served, the enrolment immediately before and after their
            stay here — one project at a time, one row per client.
          </div>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {open && projectIds.length > 0 && (
            <select className="fselect" value={pid ?? ''} onClick={(e) => e.stopPropagation()}
              onChange={(e) => setPid(Number(e.target.value))}>
              {projectIds.map((id) => (
                <option key={id} value={id}>{nameOf.get(id) ?? `Project ${id}`}</option>
              ))}
            </select>
          )}
          <span className="dd-caret">{open ? '▾' : '▸'}</span>
        </span>
      </div>

      {open && (
        <>
          {err && <div className="bnl-dq">{err}</div>}
          {loading && !data && <div className="hc-none">Loading pathways…</div>}

          {!loading && !err && data === null && (
            <div className="hc-none">
              This project served fewer than 30 clients in the two years to the cohort end —
              too few to chart a reliable pathway. Pick another project.
            </div>
          )}

          {data && (
            <>
              <div className="bnl-cnote" style={{ marginTop: 0 }}>
                <b>{fmtInt(data.n_clients)}</b> clients served
                {data.window_start && data.window_end
                  ? <> between {data.window_start} and {data.window_end}</> : null}
                . The flow below is one step each side per client; the journeys and stalls
                further down trace their whole path through the system.
              </div>

              <Sankey flow={data.data.flow} />

              {/* Top pathways */}
              <div className="hc-sub dd-pad" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                Most common journeys
                <span className="pp-toggle">
                  <button className={pathKind === 'housed' ? 'on' : ''} onClick={() => setPathKind('housed')}>to housing</button>
                  <button className={pathKind === 'churned' ? 'on' : ''} onClick={() => setPathKind('churned')}>left system</button>
                </span>
              </div>
              <TopPaths paths={data.data.top_paths[pathKind]} nodes={data.data.nodes} kind={pathKind} />

              {/* Bottleneck */}
              <div className="hc-sub dd-pad">Where clients stall — by programme stage</div>
              <Bottlenecks bn={data.data.bottleneck} />

              <p className="bnl-method">
                Built from the same By-Name List pathway logic used elsewhere — each client's most
                recent completed episode, deduplicated so a repeated stay in one programme counts
                once. <b>Left system</b> means an exit to a non-permanent destination; it is not the
                same as a bad outcome, but a high rate at a stage worth a closer look. Nothing here
                is recalculated in the browser.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ── Before/after flow Sankey ─────────────────────────────────────────────────
   Bipartite: each client contributes one "came from" (left) and one "went to"
   (right), so both columns total the cohort. A state can appear in both columns
   (someone was in ES before and someone went to ES after) — they are separate
   visual nodes, which is why cyclic movement doesn't tangle the layout.

   Node boxes carry a MIN height so a 9-client flow still gets a legible label,
   and ribbons TAPER — a ribbon's thickness at each end is that flow's share of
   the node it meets — so every box is filled exactly on both sides despite the
   min-height inflation. */
function Sankey({ flow }: { flow: { nodes: PathNode[]; links: PathLink[] } }) {
  const layout = useMemo(() => {
    const nodes = flow?.nodes ?? [];
    const links = flow?.links ?? [];
    const color = new Map(nodes.map((n) => [n.id, n.color]));
    const label = new Map(nodes.map((n) => [n.id, n.label]));

    const srcTotals = new Map<string, number>();
    const tgtTotals = new Map<string, number>();
    for (const l of links) {
      srcTotals.set(l.source, (srcTotals.get(l.source) ?? 0) + l.value);
      tgtTotals.set(l.target, (tgtTotals.get(l.target) ?? 0) + l.value);
    }
    const sources = FLOW_ORDER.filter((s) => srcTotals.has(s));
    const targets = FLOW_ORDER.filter((s) => tgtTotals.has(s));
    if (!sources.length || !targets.length) return null;

    const NODE_W = 12, GAP = 12, T = 12, B = 12, MIN_H = 18;
    // Reserve horizontal gutters for the labels so they never sit against the
    // SVG edge — this is what the "too close to the edge" fix comes down to.
    const GUT = 172;
    const W = 1000;
    const rows = Math.max(sources.length, targets.length);
    const H = T + B + rows * MIN_H + (rows - 1) * GAP + 24;
    const LX = GUT, RX = W - GUT - NODE_W;

    // Per-column exact fill: every node gets MIN_H, the remainder is shared out
    // in proportion to volume. Ribbon widths then use each node's own scale.
    const place = (col: string[], totals: Map<string, number>, x: number) => {
      const total = col.reduce((a, s) => a + (totals.get(s) ?? 0), 0) || 1;
      const avail = H - T - B - (col.length - 1) * GAP;
      const flex = Math.max(0, avail - col.length * MIN_H);
      const m = new Map<string, { x: number; y: number; h: number; total: number; cursor: number }>();
      let y = T;
      for (const s of col) {
        const tot = totals.get(s) ?? 0;
        const h = MIN_H + (tot / total) * flex;
        m.set(s, { x, y, h, total: tot, cursor: y });
        y += h + GAP;
      }
      return m;
    };
    const src = place(sources, srcTotals, LX);
    const tgt = place(targets, tgtTotals, RX);

    const ribbons = [...links]
      .sort((a, b) => b.value - a.value)
      .map((l) => {
        const s = src.get(l.source)!, t = tgt.get(l.target)!;
        const hs = (l.value / s.total) * s.h;   // share of the source box
        const ht = (l.value / t.total) * t.h;   // share of the target box
        const sy = s.cursor, ty = t.cursor;
        s.cursor += hs; t.cursor += ht;
        const x0 = LX + NODE_W, x1 = RX;
        const mx = (x0 + x1) / 2;
        return {
          key: `${l.source}-${l.target}`,
          d: `M${x0},${sy} C${mx},${sy} ${mx},${ty} ${x1},${ty} `
           + `L${x1},${ty + ht} C${mx},${ty + ht} ${mx},${sy + hs} ${x0},${sy + hs} Z`,
          color: color.get(l.source) ?? '#888',
          value: l.value, from: label.get(l.source), to: label.get(l.target),
        };
      });

    return { W, H, NODE_W, src, tgt, ribbons, color, label, srcTotals, tgtTotals };
  }, [flow]);

  if (!layout) return <div className="hc-none">Not enough flow to draw a pathway map.</div>;
  const { W, H, NODE_W, src, tgt, ribbons, color, label, srcTotals, tgtTotals } = layout;

  const nodeRects = (m: typeof src, totals: Map<string, number>, anchor: 'start' | 'end') =>
    [...m.entries()].map(([id, p]) => (
      <g key={`${anchor}-${id}`}>
        <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2.5} fill={color.get(id) ?? '#888'} />
        {/* paint-order stroke gives the label a halo so it stays readable where
            it crosses a ribbon */}
        <text x={anchor === 'start' ? p.x - 6 : p.x + NODE_W + 6} y={p.y + p.h / 2 + 3.5}
          textAnchor={anchor === 'start' ? 'end' : 'start'} fontSize={11} fontWeight={600}
          fill="var(--text)" className="pp-sk-label">
          {label.get(id)} <tspan fill="var(--muted)" fontWeight={400}>{fmtInt(totals.get(id) ?? 0)}</tspan>
        </text>
      </g>
    ));

  return (
    <div className="pp-sankey-wrap">
      <div className="pp-sankey-cols">
        <span>Came from</span><span>Went to</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="pp-sankey" role="img"
        aria-label="Where clients were immediately before and after this project">
        {ribbons.map((r) => (
          <path key={r.key} d={r.d} fill={r.color} fillOpacity={0.3}>
            <title>{`${r.from} → ${r.to}: ${fmtInt(r.value)}`}</title>
          </path>
        ))}
        {nodeRects(src, srcTotals, 'start')}
        {nodeRects(tgt, tgtTotals, 'end')}
      </svg>
    </div>
  );
}

/* ── Top pathways ─────────────────────────────────────────────────────────── */
function TopPaths({ paths, nodes, kind }: { paths: TopPath[]; nodes: PathNode[]; kind: 'housed' | 'churned' }) {
  const color = useMemo(() => new Map(nodes.map((n) => [n.id, n.color])), [nodes]);
  if (!paths.length) {
    return <div className="hc-none">No {kind === 'housed' ? 'paths to housing' : 'exits from the system'} recorded.</div>;
  }
  const max = Math.max(...paths.map((p) => p.n));
  return (
    <div className="pp-paths">
      {paths.slice(0, 10).map((p) => (
        <div className="pp-path" key={p.path}>
          <div className="pp-path-chips">
            {p.path.split('→').map((s, i, arr) => (
              <span key={i} className="pp-step">
                <span className="pp-node" style={{ background: soft(color.get(s)), color: color.get(s) ?? 'var(--text)' }}>{s}</span>
                {i < arr.length - 1 && <span className="pp-arrow">→</span>}
              </span>
            ))}
          </div>
          <div className="pp-path-bar"><i style={{ width: `${(p.n / max) * 100}%` }} /></div>
          <div className="pp-path-n">{fmtInt(p.n)} <span className="bnl-sub">· {days(p.median_days)} median</span></div>
        </div>
      ))}
    </div>
  );
}

/* ── Bottleneck cards ─────────────────────────────────────────────────────── */
function Bottlenecks({ bn }: { bn: Record<string, Bottleneck> }) {
  const rows = ORDER.filter((s) => bn[s]).map((s) => bn[s]);
  if (!rows.length) return <div className="hc-none">No stage data.</div>;
  return (
    <div className="pp-bn-grid">
      {rows.map((b) => (
        <div className="pp-bn" key={b.label}>
          <div className="pp-bn-h">
            <span className="pp-node" style={{ background: soft(b.color), color: b.color }}>{b.label}</span>
            <span className="bnl-sub">{fmtInt(b.n)} enrolments</span>
          </div>
          {/* housed / churned / active split */}
          <div className="pp-bn-bar" title={`Housed ${b.ph_rate}% · Left ${b.churn_rate}% · Still enrolled ${b.active_rate}%`}>
            <i style={{ width: `${b.ph_rate}%`, background: 'var(--accent)' }} />
            <i style={{ width: `${b.churn_rate}%`, background: 'var(--faint)' }} />
            <i style={{ width: `${b.active_rate}%`, background: 'var(--secondary)' }} />
          </div>
          <div className="pp-bn-legend">
            <span><i style={{ background: 'var(--accent)' }} />Housed {b.ph_rate}%</span>
            <span><i style={{ background: 'var(--faint)' }} />Left {b.churn_rate}%</span>
            <span><i style={{ background: 'var(--secondary)' }} />Active {b.active_rate}%</span>
          </div>
          <div className="pp-bn-stat">
            <span>Median stay</span><b>{days(b.median_los)}</b>
          </div>
          {b.exit_tiers.n_total > 0 && (
            <div className="pp-bn-stat" title="Of clients who left without permanent housing, the share whose destination was streets / shelter / safe haven">
              <span>Left to homelessness</span>
              <b style={b.exit_tiers.homeless.pct >= 50 ? { color: 'var(--danger)' } : undefined}>
                {b.exit_tiers.homeless.pct}%
              </b>
            </div>
          )}
          {b.next_steps.length > 0 && (
            <div className="pp-bn-next">
              Next: {b.next_steps.slice(0, 3).map((n) => `${n.to} ${n.pct}%`).join(' · ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Faint tint of a solid hex for chip backgrounds. */
function soft(hex?: string): string {
  const m = hex && /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'var(--track)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.15)`;
}
