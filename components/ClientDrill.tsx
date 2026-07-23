'use client';

import { useState, useCallback } from 'react';
import { periodLabel } from '../lib/format';

/**
 * Client drill-down — the hashed PersonalIDs behind one table cell.
 *
 * Extracted from the Project Performance table so the Returns table can reuse
 * the exact same modal and fetch. Hashed IDs only, never names — identifying a
 * person still needs HMIS access. RLS on drill_clients (`scoped read drill`) is
 * the real boundary; an agency user hitting another agency's project gets [].
 */
export interface DrillTarget {
  project: string; projectId: number; metric: string; label: string; expected: number;
}

export function useClientDrill(period: string) {
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [ids, setIds] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const open = useCallback(async (t: DrillTarget) => {
    setDrill(t); setIds(null); setErr(null);
    try {
      const qs = new URLSearchParams({ period, project_id: String(t.projectId), metric: t.metric });
      const res = await fetch(`/api/drill?${qs}`, { credentials: 'same-origin' });
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? 'Could not load clients.'); setIds([]); }
      else setIds(j.ids as string[]);
    } catch {
      setErr('Could not load clients.'); setIds([]);
    }
  }, [period]);

  const close = useCallback(() => setDrill(null), []);
  return { drill, ids, err, open, close, period };
}

export function DrillModal({
  drill, ids, err, period, onClose,
}: {
  drill: DrillTarget | null; ids: string[] | null; err: string | null;
  period: string; onClose: () => void;
}) {
  if (!drill) return null;
  return (
    <div className="bnl-ov" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bnl-modal">
        <button className="bnl-x" onClick={onClose}>✕</button>
        <h3>{drill.label}</h3>
        <div className="bnl-sub" style={{ marginTop: 2 }}>{drill.project} · {periodLabel(period)}</div>

        {ids === null && <div className="hc-none">Loading clients…</div>}
        {err && <div className="bnl-dq" style={{ marginTop: 12 }}>{err}</div>}

        {ids && !err && (
          <>
            <div className="dr-head">
              <span>
                <b>{ids.length.toLocaleString()}</b> client{ids.length === 1 ? '' : 's'}
                {ids.length !== drill.expected && (
                  <span className="bnl-sub"> · table shows {drill.expected.toLocaleString()}</span>
                )}
              </span>
              {ids.length > 0 && (
                <button className="btn" onClick={(e) => {
                  navigator.clipboard?.writeText(ids.join('\n'));
                  const el = e.currentTarget; el.textContent = 'Copied ✓';
                  setTimeout(() => { el.textContent = '⧉ Copy IDs'; }, 1200);
                }}>⧉ Copy IDs</button>
              )}
            </div>
            {ids.length === 0 ? (
              <div className="hc-none">
                No clients to show. Either this metric was zero for the period, or your
                account does not have access to this project.
              </div>
            ) : (
              <>
                <div className="dr-ids">{ids.map((id) => <code key={id}>{id}</code>)}</div>
                <p className="bnl-sub" style={{ marginTop: 10 }}>
                  These are hashed PersonalIDs — HMIS access is required to identify individuals.
                  Paste one into HMIS client search to look it up.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
