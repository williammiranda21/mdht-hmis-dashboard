'use client';

import { useState } from 'react';

/**
 * Targets & progress (Pillar 3-4) — admin-set per-project targets with progress
 * bars against the SAME stored values shown elsewhere on the panel. Direction
 * matters: PH exit rate and DQ score are at-or-above targets; the 2-year return
 * rate is an at-or-below target. Admins edit inline (writes via /api/targets);
 * everyone else sees progress only. No target set → row shows "no target".
 */

const METRICS: { key: string; label: string; unit: string; higherBetter: boolean }[] = [
  { key: 'ph_exit_rate', label: 'PH exit rate', unit: '%', higherBetter: true },
  { key: 'dq_score', label: 'DQ score', unit: '', higherBetter: true },
  { key: 'returns_2yr', label: '2-year return rate', unit: '%', higherBetter: false },
];

export interface TargetsData {
  editable: boolean;
  rows: { metric: string; target: number }[];
  current: Record<string, number | null>;
}

export default function TargetsSection({ projectId, data }: { projectId: number; data: TargetsData | null }) {
  const [rows, setRows] = useState<Record<string, number | null>>(() =>
    Object.fromEntries((data?.rows ?? []).map((r) => [r.metric, r.target])));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);

  if (!data) return null;
  const anyTarget = METRICS.some((m) => rows[m.key] != null);
  if (!anyTarget && !data.editable) return null;   // nothing to show non-admins

  const save = (metric: string, value: number | null) => {
    setErr(null);
    fetch('/api/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, metric, target: value }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(() => setRows((s) => ({ ...s, [metric]: value })))
      .catch(() => setErr('Could not save the target.'));
    setEditing(null);
  };

  const fmt = (v: number | null, unit: string) => (v == null ? '—' : `${Number(v.toFixed(1))}${unit}`);

  return (
    <>
      <div className="hc-sub">Targets &amp; progress</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {METRICS.map((m) => {
          const target = rows[m.key] ?? null;
          const cur = data.current[m.key] ?? null;
          const met = target != null && cur != null
            && (m.higherBetter ? cur >= target : cur <= target);
          // Bar = progress toward the target (capped); for lower-is-better the
          // bar fills as the value drops toward the target.
          const pct = target == null || cur == null ? 0
            : m.higherBetter
              ? Math.min(100, (cur / Math.max(target, 1e-9)) * 100)
              : Math.min(100, (Math.max(target, 1e-9) / Math.max(cur, 1e-9)) * 100);
          return (
            <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 150 }}>{m.label}</span>
              <span style={{ minWidth: 64, fontWeight: 600 }}>{fmt(cur, m.unit)}</span>
              <span style={{ flex: 1, minWidth: 120, height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${pct}%`,
                  background: target == null ? 'var(--border)' : met ? 'var(--accent)' : 'var(--warn)' }} />
              </span>
              {editing === m.key ? (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <input className="finput" style={{ width: 80 }} autoFocus value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = draft.trim() === '' ? null : Number(draft);
                        if (v == null || (Number.isFinite(v) && v >= 0 && v <= 100)) save(m.key, v);
                      }
                      if (e.key === 'Escape') setEditing(null);
                    }} />
                  <button className="btn" onClick={() => {
                    const v = draft.trim() === '' ? null : Number(draft);
                    if (v == null || (Number.isFinite(v) && v >= 0 && v <= 100)) save(m.key, v);
                  }}>Save</button>
                </span>
              ) : (
                <span className="bnl-sub" style={{ minWidth: 110 }}>
                  {target == null ? 'no target' : `target ${m.higherBetter ? '≥' : '≤'} ${fmt(target, m.unit)}`}
                  {target != null && met && <span style={{ color: 'var(--accent)', fontWeight: 700 }}> ✓</span>}
                  {data.editable && (
                    <button className="btn" style={{ marginLeft: 8, padding: '0 8px', fontSize: 12 }}
                      onClick={() => { setEditing(m.key); setDraft(target == null ? '' : String(target)); }}>
                      {target == null ? 'set' : 'edit'}
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {err && <div className="bnl-dq" style={{ marginTop: 6 }}>{err}</div>}
    </>
  );
}
