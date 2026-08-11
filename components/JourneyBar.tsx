/**
 * CE journey bar — the proportional milestone visualization shared by the
 * By-Name List system card and the cohort dashboard, so the two can never
 * drift visually. Extracted verbatim from BnlView (user-approved "perfect"
 * iteration, 2026-07-31).
 *
 * Anatomy: bold milestone labels as nodes; each connector's WIDTH is
 * proportional to its completed median (min width keeps 0d legs visible);
 * the day count floats above its segment (bold median + muted avg, ⏳ on the
 * longest leg); under each segment, the clients currently stuck on that leg
 * and their live wait — warn-bold when the live wait dwarfs the completed
 * median (≥2×, 7d floor), i.e. the completed figure is a workflow artifact
 * and the backlog is the real story.
 *
 * Presentation only — every figure arrives precomputed (meta.ce_milestones
 * for the BNL, /api/cohorts agg for cohorts). Do not add math here.
 */

export interface JourneyLegStat {
  n: number;
  median: number | null;
  mean?: number | null;
}

export default function JourneyBar({ order, labels, housed, waiting, onLegClick }: {
  order: string[];                                      // milestone keys, journey order
  labels: Record<string, string>;                       // key → display label
  housed: Record<string, JourneyLegStat | undefined>;   // completed legs, keyed `${a}_${b}`
  waiting?: Record<string, JourneyLegStat | undefined>; // live stalls, keyed by milestone
  /** makes each "N waiting" line clickable — the worklist for that leg */
  onLegClick?: (milestone: string) => void;
}) {
  const legs = order.slice(0, -1).map((a, i) => [a, order[i + 1]] as const);
  const meds = legs.map(([a, b]) => housed[`${a}_${b}`]?.median ?? null);
  const worst = Math.max(...meds.map((m) => m ?? -1));

  return (
    <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', padding: '24px 4px 28px' }}>
      {order.map((k, i) => {
        const isLast = i === order.length - 1;
        const b = order[i + 1];
        const s = isLast ? null : housed[`${k}_${b}`];
        const isWorst = s?.median != null && s.median === worst && worst >= 0;
        return (
          <span key={k} style={{ display: 'contents' }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--strong)', whiteSpace: 'nowrap', letterSpacing: '.01em' }}>
              {labels[k] ?? k}
            </span>
            {!isLast && (() => {
              const w = waiting?.[k];
              const liveIsStory = (w?.median ?? 0) >= 2 * Math.max(s?.median ?? 0, 7);
              return (
                <span
                  title={`${labels[k] ?? k} → ${labels[b] ?? b}${s?.n ? ` — completed: median ${s.median}d · avg ${s.mean}d · ${s.n} clients${isWorst ? ' · longest leg' : ''}` : ' — no completed pairs'}${w?.n ? ` · waiting now: ${w.n} clients, median ${w.median}d${w.mean != null ? ` · avg ${w.mean}d` : ''} and counting` : ''}`}
                  style={{ position: 'relative', display: 'flex', alignItems: 'center',
                    flexGrow: Math.max(s?.median ?? 0, 4), flexBasis: 84, minWidth: 84, padding: '0 10px' }}>
                  <span style={{ position: 'absolute', top: -19, left: 0, right: 0, textAlign: 'center',
                    fontSize: 11.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                    color: isWorst ? 'var(--warn)' : 'var(--muted)' }}>
                    <b>{s?.median != null ? `${s.median}d` : '—'}</b>
                    {s?.mean != null && <span style={{ fontSize: 10, opacity: .85 }}> · avg {Math.round(s.mean)}d</span>}
                    {isWorst ? ' ⏳' : ''}
                  </span>
                  <span style={{ display: 'block', width: '100%', height: 6, borderRadius: 3,
                    background: isWorst ? 'var(--warn)' : 'var(--primary)',
                    opacity: s?.median != null ? 0.9 : 0.25 }} />
                  {(w?.n ?? 0) > 0 && (
                    <span
                      role={onLegClick ? 'button' : undefined}
                      tabIndex={onLegClick ? 0 : undefined}
                      onClick={onLegClick ? (e) => { e.stopPropagation(); onLegClick(k); } : undefined}
                      onKeyDown={onLegClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLegClick(k); } } : undefined}
                      title={onLegClick ? `Show the ${w!.n.toLocaleString()} clients waiting at ${labels[k] ?? k}, longest first` : undefined}
                      style={{ position: 'absolute', top: 'calc(50% + 8px)', left: 0, right: 0, textAlign: 'center',
                        whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                        fontSize: liveIsStory ? 11 : 10.5,
                        fontWeight: liveIsStory ? 700 : 400,
                        color: liveIsStory ? 'var(--warn)' : 'var(--muted)',
                        cursor: onLegClick ? 'pointer' : undefined,
                        textDecoration: onLegClick ? 'underline dotted' : undefined,
                        textUnderlineOffset: 3 }}>
                      {(w!.n).toLocaleString()} waiting · <b>{w!.median}d</b>
                      {w!.mean != null && <span style={{ fontSize: 10, opacity: .85 }}> · avg {Math.round(w!.mean!)}d</span>}
                    </span>
                  )}
                </span>
              );
            })()}
          </span>
        );
      })}
    </div>
  );
}
