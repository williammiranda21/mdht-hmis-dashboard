'use client';

import { useEffect, useState } from 'react';
import { fmtInt } from '../../../lib/format';

/**
 * Lease-up funnel (Pillar 3-4) — enrollment → move-in for the PH-type projects
 * in the Deep Dive selection. The piece nothing else shows is the AGED awaiting
 * queue: how many households are waiting <30 / 30-90 / 90+ days for a unit, plus
 * 90-day velocity (move-ins vs new entries — is the queue draining or growing?).
 * Snapshot as of the export end date, from /api/leaseup (leaseup_funnel table).
 */

interface Row {
  project_id: number; name: string; type: string | null; as_of: string;
  enrolled_hh: number; movedin_hh: number; awaiting: number;
  buckets: { lt30: number; d30_90: number; d90p: number };
  median_wait: number | null; max_wait: number | null;
  movedin_90d: number; entered_90d: number;
}

export default function LeaseUpFunnel({ projectIds }: { projectIds: number[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!projectIds.length) { setRows(null); return; }
    let live = true;
    setErr(false);
    fetch(`/api/leaseup?projects=${projectIds.join(',')}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (live) setRows(j.rows ?? []); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [projectIds]);

  // Silent when nothing in the selection is a PH-type project — this section
  // simply doesn't apply, so an empty state would be noise.
  if (err || !rows || !rows.length) return null;

  const sorted = [...rows].sort((a, b) => (b.buckets.d90p - a.buckets.d90p) || (b.awaiting - a.awaiting));
  const asOf = rows[0].as_of;

  return (
    <div className="panel">
      <div className="panel-h dd-head" role="button" tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}>
        <div>
          <h3>Lease-up funnel <span className="bnl-sub">({rows.length} housing project{rows.length === 1 ? '' : 's'})</span></h3>
          <div className="meta">
            Open household enrollments → move-ins, as of {asOf}. Sorted by the number
            waiting 90+ days. Referrals aren’t shown — HMIS can’t tie a CE referral to
            a specific project.
          </div>
        </div>
        <span className="dd-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="scroll">
        <table className="bnl-table">
          <thead>
            <tr>
              <th>Project</th>
              <th className="num">Enrolled HH</th>
              <th className="num">Moved in</th>
              <th>Awaiting move-in (by wait)</th>
              <th className="num">Median wait</th>
              <th className="num">90-day flow</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const segs = [
                { n: r.buckets.lt30, color: 'var(--accent)', label: '<30d' },
                { n: r.buckets.d30_90, color: 'var(--warn)', label: '30–90d' },
                { n: r.buckets.d90p, color: 'var(--danger)', label: '90+d' },
              ].filter((s) => s.n > 0);
              const net = r.movedin_90d - r.entered_90d;
              return (
                <tr key={r.project_id}>
                  <td title={r.type ?? undefined}>{r.name}</td>
                  <td className="num">{fmtInt(r.enrolled_hh)}</td>
                  <td className="num">
                    {fmtInt(r.movedin_hh)}
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {' '}({r.enrolled_hh ? Math.round((r.movedin_hh / r.enrolled_hh) * 100) : 0}%)
                    </span>
                  </td>
                  <td>
                    {r.awaiting === 0
                      ? <span style={{ color: 'var(--muted)' }}>none 🎉</span>
                      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ display: 'inline-flex', width: 120, height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--border)' }}
                            title={segs.map((s) => `${s.label}: ${s.n}`).join(' · ')}>
                            {segs.map((s, i) => (
                              <span key={i} style={{ width: `${(s.n / r.awaiting) * 100}%`, background: s.color }} />
                            ))}
                          </span>
                          <span style={{ fontSize: 12 }}>
                            <b>{fmtInt(r.awaiting)}</b>
                            {r.buckets.d90p > 0 && (
                              <span style={{ color: 'var(--danger)', fontWeight: 600 }}> · {r.buckets.d90p} at 90+d</span>
                            )}
                          </span>
                        </span>}
                  </td>
                  <td className="num">{r.median_wait != null ? `${r.median_wait}d` : '—'}</td>
                  <td className="num" title={`${r.movedin_90d} moved in vs ${r.entered_90d} new entries in the last 90 days`}>
                    <span style={{ color: net >= 0 ? 'var(--accent)' : 'var(--warn)', fontWeight: 600 }}>
                      {net >= 0 ? '▲' : '▼'} {r.movedin_90d}/{r.entered_90d}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
    </div>
  );
}
