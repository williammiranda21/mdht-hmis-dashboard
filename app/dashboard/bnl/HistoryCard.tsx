import type { BnlHist3 } from './types';

/** Full labels for the compact HUD project-type codes used in `hist3.types`. */
const TYPE_FULL: Record<string, string> = {
  ES: 'Emergency Shelter', SH: 'Safe Haven', TH: 'Transitional Housing',
  SO: 'Street Outreach', PSH: 'Permanent Supportive Housing',
  RRH: 'Rapid Re-Housing', PH: 'Permanent Housing', CE: 'Coordinated Entry',
};

/** '2026-07-23' → '7/23/2026' without tripping over timezones (no Date parse). */
function md(s: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${+m}/${+d}/${y}`;
}

/** Frequent-contact clients can have 25+ one-day episodes; the oldest are the
 *  least useful in case conferencing, so show the newest N and count the rest. */
const EP_MAX = 8;

/**
 * 3-year homeless history card for the client drawer.
 *
 * Presentation only — every figure comes precomputed from `bnl_core.py` (hist3),
 * derived from the same merged intervals as `sys_days3`/`episodes3`. Do not add
 * math here; it would risk drifting from the Python source of truth.
 */
export default function HistoryCard({ h }: { h: BnlHist3 | null }) {
  if (!h) return null;

  const t0 = Date.parse(h.s), t1 = Date.parse(h.e);
  const span = t1 - t0 || 1;
  const pos = (a: string, b: string) => {
    const x0 = Math.max(Date.parse(a), t0), x1 = Math.min(Date.parse(b), t1);
    if (x1 < x0) return null;
    // floor the width so a single-day episode is still visible on a 3-year track
    return { l: (100 * (x0 - t0)) / span, w: Math.max((100 * (x1 - x0)) / span, 0.6) };
  };

  const segs = [
    ...h.ranges.map((g) => ({ p: pos(g.s, g.e), c: 'h' })),
    ...h.placed.map((q) => ({ p: pos(q.s, q.e), c: 'p' })),
  ].filter((s) => s.p);

  const [bandCls, bandTxt] =
    h.days >= 365 ? ['hc-hi', 'Extensive history']
      : h.days >= 90 ? ['hc-md', 'Moderate history']
        : ['hc-lo', 'Low history'];

  const recent = h.ranges.slice().reverse();
  const hidden = Math.max(recent.length - EP_MAX, 0);

  return (
    <div className="hcard">
      <div className="hc-h">
        <b>Homeless History (Last 3 Years)</b>
        <span className={`hc-bdg ${bandCls}`}>{bandTxt}</span>
      </div>

      <div className="hc-tiles">
        <div className="hc-t">
          <div className="k">Days homeless</div>
          <div className="v">{h.days.toLocaleString()}</div>
          <div className="s">{h.last ? `Last homeless: ${md(h.last)}` : '—'}</div>
        </div>
        <div className="hc-t">
          <div className="k">Episodes</div>
          <div className="v">{h.eps}</div>
          <div className="s">distinct stints</div>
        </div>
        <div className="hc-t">
          <div className="k">Times housed</div>
          <div className="v">{h.housed_n}</div>
          <div className="s">PH move-ins</div>
        </div>
        <div className="hc-t">
          <div className="k">Returns to homeless</div>
          <div className="v">{h.returns}</div>
          <div className="s">episodes after a move-in</div>
        </div>
      </div>

      <div className="hc-ends"><span>{md(h.s)}</span><span>{md(h.e)}</span></div>
      <div className="hc-track">
        {segs.map((s, i) => (
          <i key={i} className={`hc-seg ${s.c}`} style={{ left: `${s.p!.l}%`, width: `${s.p!.w}%` }} />
        ))}
      </div>
      <div className="hc-leg">
        <span className="hc-lg-h">Homeless</span>
        <span className="hc-lg-p">Housed</span>
        <span className="hc-lg-n">No enrollment</span>
      </div>

      <div className="hc-sub">Days by project type</div>
      {h.types.length ? h.types.map((t) => (
        <div className="hc-row" key={t.t}>
          <span className="hc-pill">{t.t}</span>
          <div className="hc-bwrap">
            <div className="hc-blab">
              <span>{TYPE_FULL[t.t] ?? t.t}</span>
              <b>{t.d.toLocaleString()}d ({t.pct}%)</b>
            </div>
            <div className="hc-bar"><i style={{ width: `${t.pct}%` }} /></div>
          </div>
        </div>
      )) : <div className="hc-none">No enrollment days recorded in this window</div>}

      <div className="hc-sub">Homeless episodes ({h.ranges.length})</div>
      {recent.length ? (
        <>
          {recent.slice(0, EP_MAX).map((g, i) => (
            <div className="hc-ep" key={i}>
              <span className="d">{md(g.s)} › {md(g.e)}</span>
              <b>{g.d.toLocaleString()}d</b>
            </div>
          ))}
          {hidden > 0 && (
            <div className="hc-none">+ {hidden} earlier episode{hidden === 1 ? '' : 's'}</div>
          )}
        </>
      ) : <div className="hc-none">No homeless episodes in the last 3 years</div>}

      <div className="hc-sub">Housing placements ({h.placed.length})</div>
      {h.placed.length ? h.placed.map((p, i) => (
        <div className="hc-ep ph" key={i}>
          <span className="d">
            {md(p.s)} › {p.open ? 'present' : md(p.e)}
            <span className="bnl-sub"> · {p.t}{p.p ? ` · ${p.p}` : ''}</span>
          </span>
        </div>
      )) : <div className="hc-none">No housing placements in the last 3 years</div>}
    </div>
  );
}
