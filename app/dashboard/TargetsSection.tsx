'use client';

import { useState } from 'react';
import { TARGET_METRICS, fmtTarget, type TargetMetric } from '../../lib/target-metrics';

/**
 * Targets & progress (Pillar 3-4) — progress bars against the SAME stored
 * values shown elsewhere on the panel. Metric definitions (units, direction,
 * ranges, hints) live in lib/target-metrics.ts, shared with the admin page.
 *
 * A target resolves project override (project_targets) → type default
 * (type_targets); inherited rows are labelled "type default". Inline edits here
 * always write the PROJECT override — clearing one falls back to the type
 * default. Type defaults are managed at /dashboard/admin/targets. Admins see
 * every metric; non-admins see only metrics with an effective target.
 */

export interface TargetsData {
  editable: boolean;
  rows: { metric: string; target: number }[];      // project overrides
  typeRows: { metric: string; target: number }[];  // type defaults
  current: Record<string, number | null>;
}

export default function TargetsSection({ projectId, data }: { projectId: number; data: TargetsData | null }) {
  const [rows, setRows] = useState<Record<string, number | null>>(() =>
    Object.fromEntries((data?.rows ?? []).map((r) => [r.metric, r.target])));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);

  if (!data) return null;
  const typeDefault: Record<string, number | undefined> =
    Object.fromEntries((data.typeRows ?? []).map((r) => [r.metric, r.target]));
  const effective = (key: string): number | null => rows[key] ?? typeDefault[key] ?? null;

  const anyTarget = TARGET_METRICS.some((m) => effective(m.key) != null);
  if (!anyTarget && !data.editable) return null;   // nothing to show non-admins

  // Non-admins see progress only — hide untargeted rows for them.
  const visible = data.editable ? TARGET_METRICS : TARGET_METRICS.filter((m) => effective(m.key) != null);

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

  // Tolerate a typed "%" / "days" suffix; blank clears the override; out-of-range
  // explains the expected format instead of silently doing nothing.
  const trySave = (m: TargetMetric) => {
    const raw = draft.trim().replace(/%$/, '').replace(/\s*days?$/i, '').trim();
    const v = raw === '' ? null : Number(raw);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > m.max)) {
      setErr(`${m.label}: enter a number between 0 and ${m.max}${m.unit === '%' ? ' (percent — no % sign needed)' : m.unit ? ' (days)' : ''}, or leave blank to clear.`);
      return;
    }
    setErr(null);
    save(m.key, v);
  };

  return (
    <>
      <div className="hc-sub">Targets &amp; progress</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {visible.map((m) => {
          const override = rows[m.key] ?? null;
          const target = effective(m.key);
          const inherited = override == null && target != null;
          const cur = data.current[m.key] ?? null;
          const met = target != null && cur != null
            && (m.higherBetter ? cur >= target : cur <= target);
          // Bar = progress toward the target (capped); for lower-is-better the
          // bar fills as the value drops toward the target.
          const pct = target == null || cur == null ? 0
            : m.higherBetter
              ? Math.min(100, (cur / Math.max(target, 1e-9)) * 100)
              : Math.min(100, (Math.max(target, 1e-9) / Math.max(cur, 1e-9)) * 100);
          const fallback = typeDefault[m.key];
          const clearNote = fallback != null
            ? ` Blank falls back to the type default (${fmtTarget(fallback, m.unit)}).`
            : ' Blank clears the target.';
          return (
            <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 170 }}>{m.label}</span>
              <span style={{ minWidth: 64, fontWeight: 600 }}>{fmtTarget(cur, m.unit)}</span>
              <span style={{ flex: 1, minWidth: 120, height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${pct}%`,
                  background: target == null ? 'var(--border)' : met ? 'var(--accent)' : 'var(--warn)' }} />
              </span>
              {editing === m.key ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input className="finput" style={{ width: 90 }} autoFocus value={draft}
                    placeholder={m.placeholder} inputMode="decimal"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') trySave(m);
                      if (e.key === 'Escape') { setEditing(null); setErr(null); }
                    }} />
                  {m.unit.trim() !== '' && <span className="bnl-sub">{m.unit.trim()}</span>}
                  <button className="btn" onClick={() => trySave(m)}>Save</button>
                </span>
              ) : (
                <span className="bnl-sub" style={{ minWidth: 110 }}>
                  {target == null ? 'no target'
                    : `target ${m.higherBetter ? '≥' : '≤'} ${fmtTarget(target, m.unit)}${inherited ? ' · type default' : ''}`}
                  {target != null && met && <span style={{ color: 'var(--accent)', fontWeight: 700 }}> ✓</span>}
                  {data.editable && (
                    <button className="btn" style={{ marginLeft: 8, padding: '0 8px', fontSize: 12 }}
                      onClick={() => { setEditing(m.key); setDraft(override == null ? '' : String(override)); setErr(null); }}>
                      {override == null ? 'set' : 'edit'}
                    </button>
                  )}
                </span>
              )}
              {editing === m.key && (
                <span className="bnl-sub" style={{ flexBasis: '100%', fontSize: 12 }}>{m.hint}{clearNote}</span>
              )}
            </div>
          );
        })}
      </div>
      {err && <div className="bnl-dq" style={{ marginTop: 6 }}>{err}</div>}
    </>
  );
}
