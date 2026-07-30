'use client';

import { useEffect, useState } from 'react';
import { periodLabel, fmtInt } from '../../../lib/format';

/**
 * Since-last-month digest (Pillar 3) — "what changed" for the Deep Dive
 * selection. Compares the last two COMPLETE months (the API decides which;
 * deliberately independent of the worklist period picker below it, which can
 * point at the partial month). Pure presentation over /api/digest diffs.
 */

interface Pair { prev: number | null; cur: number | null }
interface DigestRow {
  project_id: number; name: string; type: string | null;
  clients: Pair; ph_rate: Pair; avg_los: Pair; dq_score: Pair;
  err_new: number; err_cleared: number;
  top_new_element: { label: string; n: number } | null;
}
interface DigestData { cur: string; prev: string; rows: DigestRow[] }

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
  if (!data.rows.length) return null;

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
          <h3>What changed <span className="bnl-sub">{periodLabel(data.cur)} vs {periodLabel(data.prev)}</span></h3>
          <div className="meta">
            Last two complete months. New/cleared counts are unique clients on the
            data-quality fix-list; the worklists below follow their own period picker.
          </div>
        </div>
        <span className="dd-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="scroll">
        <table className="bnl-table">
          <thead>
            <tr>
              <th>Project</th>
              <th className="num">Clients</th>
              <th className="num">PH exit rate</th>
              <th className="num">Avg LOS</th>
              <th className="num">DQ score</th>
              <th>DQ fix-list</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.project_id}>
                <td title={r.type ?? undefined}>{r.name}</td>
                <td className="num"><Delta p={r.clients} unit="" dir="none" dp={0} /></td>
                <td className="num"><Delta p={r.ph_rate} unit="%" dir="up" dp={2} /></td>
                <td className="num"><Delta p={r.avg_los} unit="d" dir="none" /></td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </div>
  );
}
