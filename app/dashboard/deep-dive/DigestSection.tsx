'use client';

import { useEffect, useState } from 'react';
import { periodLabel, fmtInt } from '../../../lib/format';
import { fmtTarget } from '../../../lib/target-metrics';

/**
 * Since-last-month digest (Pillar 3) — "what changed" for the Deep Dive
 * selection. Compares the last two COMPLETE months (the API decides which;
 * deliberately independent of the worklist period picker below it, which can
 * point at the partial month). Pure presentation over /api/digest diffs.
 */

interface Pair { prev: number | null; cur: number | null }
interface DigestRow {
  project_id: number; name: string; type: string | null;
  dq_score: Pair;
  err_new: number; err_cleared: number;
  top_new_element: { label: string; n: number } | null;
  /** Fixed-since-refresh ledger (dq_snapshots) — records repaired since the
   *  previous capture, incl. retroactive fixes invisible to the month diff. */
  fixed_n: number;
  fixed_top: { label: string; n: number } | null;
  score_since: number | null;
}
interface TargetMissLine {
  label: string; unit: string; higherBetter: boolean; target: number; current: number;
}
interface DigestData {
  cur: string; prev: string; rows: DigestRow[];
  fixed_base: string | null; fixed_period: string | null;
  /** Off-target headline — projects below their admin-set targets for `period`,
   *  `newly` = was NOT below last month (i.e. fell below this month). */
  targets?: {
    period: string;
    below: { project_id: number; name: string; newly: boolean; misses: TargetMissLine[] }[];
  } | null;
}

/** Delta chip. `dir` says which direction is good; neutral renders muted. */
function Delta({ p, unit, dir, dp = 1 }: { p: Pair; unit: string; dir: 'up' | 'down' | 'none'; dp?: number }) {
  if (p.cur == null && p.prev == null) return <span style={{ color: 'var(--muted)' }}>—</span>;
  const f = (v: number | null) => (v == null ? '—' : `${Number(v.toFixed(dp))}${unit}`);
  if (p.cur == null || p.prev == null) return <span>{f(p.cur ?? p.prev)}</span>;
  const d = p.cur - p.prev;
  const shown = Math.abs(d) < 0.05 ? 0 : d;
  const color = shown === 0 || dir === 'none' ? 'var(--muted)'
    : (shown > 0) === (dir === 'up') ? 'var(--accent)' : 'var(--danger)';
  return (
    <span title={`${f(p.prev)} → ${f(p.cur)}`}>
      {f(p.cur)}{' '}
      <span style={{ color, fontSize: 12, fontWeight: 600 }}>
        {shown === 0 ? '·' : `${shown > 0 ? '▲' : '▼'} ${Number(Math.abs(d).toFixed(dp))}`}
      </span>
    </span>
  );
}

export default function DigestSection({ projectIds }: { projectIds: number[] }) {
  const [data, setData] = useState<DigestData | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!projectIds.length) { setData(null); return; }
    let live = true;
    setErr(false);
    fetch(`/api/digest?projects=${projectIds.join(',')}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setData(j); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [projectIds]);

  if (!projectIds.length || err) return null;
  if (!data) return <div className="panel"><div className="hc-none">Loading digest…</div></div>;
  // Keep the panel when projects are below target even if DQ didn't move —
  // the off-target headline must not disappear with a quiet DQ month.
  if (!data.rows.length && !(data.targets?.below.length ?? 0)) return null;

  // Most movement first: new errors weigh heaviest (actionable), then DQ swing.
  const rows = [...data.rows].sort((a, b) => {
    const w = (r: DigestRow) =>
      r.err_new * 2 + r.err_cleared +
      Math.abs((r.dq_score.cur ?? 0) - (r.dq_score.prev ?? 0));
    return w(b) - w(a);
  });

  return (
    <div className="panel">
      <div className="panel-h dd-head" role="button" tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}>
        <div>
          <h3>Data quality — what changed <span className="bnl-sub">{periodLabel(data.cur)} vs {periodLabel(data.prev)}</span></h3>
          <div className="meta">
            Last two complete months. New/cleared counts are unique clients on the
            data-quality fix-list. Performance deltas live in the performance grid below.
          </div>
        </div>
        <span className="dd-caret">{open ? '▾' : '▸'}</span>
      </div>
      {/* Off-target headline — ALWAYS visible (even collapsed): targets should
          be something admins notice, not something they go look up. */}
      {(data.targets?.below.length ?? 0) > 0 && (() => {
        const below = data.targets!.below;
        const newly = below.filter((b) => b.newly).length;
        const SHOW = 4;
        return (
          <div className="dg-below">
            <span className="dg-below-n">⚑ {below.length} project{below.length === 1 ? '' : 's'} below target</span>
            {' '}for {periodLabel(data.targets!.period)}
            {newly > 0 && <> · <b>{newly} fell below this month</b></>}
            {': '}
            {below.slice(0, SHOW).map((b, i) => (
              <span key={b.project_id} title={b.misses
                .map((m) => `${m.label}: ${fmtTarget(m.current, m.unit)} vs target ${m.higherBetter ? '≥' : '≤'} ${fmtTarget(m.target, m.unit)}`)
                .join(' · ')}>
                {i > 0 && ' · '}
                {b.name} <span className="bnl-sub">({b.misses.length === 1 ? b.misses[0].label : `${b.misses.length} metrics`}{b.newly ? ' · new' : ''})</span>
              </span>
            ))}
            {below.length > SHOW && <span className="bnl-sub"> +{below.length - SHOW} more</span>}
          </div>
        );
      })()}
      {open && <div className="scroll">
        <table className="bnl-table">
          <thead>
            <tr>
              <th>Project</th>
              <th className="num">DQ score</th>
              <th>DQ fix-list</th>
              {data.fixed_base && (
                <th title={`Records repaired since the ${data.fixed_base} refresh capture — same-month comparison, so retroactive fixes count too`}>
                  Fixed since {data.fixed_base}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.project_id}>
                <td title={r.type ?? undefined}>{r.name}</td>
                <td className="num"><Delta p={r.dq_score} unit="" dir="up" /></td>
                <td>
                  {r.err_new === 0 && r.err_cleared === 0
                    ? <span style={{ color: 'var(--muted)' }}>no change</span>
                    : <>
                        {r.err_new > 0 && (
                          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                            {fmtInt(r.err_new)} new
                          </span>
                        )}
                        {r.err_new > 0 && r.err_cleared > 0 && <span style={{ color: 'var(--muted)' }}> · </span>}
                        {r.err_cleared > 0 && (
                          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                            {fmtInt(r.err_cleared)} cleared
                          </span>
                        )}
                        {r.top_new_element && (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                            {' '}(most new: {r.top_new_element.label})
                          </span>
                        )}
                      </>}
                </td>
                {data.fixed_base && (
                  <td>
                    {r.fixed_n > 0
                      ? <>
                          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{fmtInt(r.fixed_n)} fixed</span>
                          {r.fixed_top && (
                            <span style={{ color: 'var(--muted)', fontSize: 12 }}> (most: {r.fixed_top.label})</span>
                          )}
                          {r.score_since != null && Math.abs(r.score_since) >= 0.05 && (
                            <span style={{ color: r.score_since > 0 ? 'var(--accent)' : 'var(--danger)', fontSize: 12, fontWeight: 600 }}>
                              {' '}· score {r.score_since > 0 ? '+' : ''}{Number(r.score_since.toFixed(1))}
                            </span>
                          )}
                        </>
                      : <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </div>
  );
}
