'use client';

import { TARGET_METRICS, fmtTarget } from '../../lib/target-metrics';

/**
 * Targets & progress (Pillar 3-4) — READ-ONLY progress bars against the SAME
 * stored values shown elsewhere on the panel. Metric definitions live in
 * lib/target-metrics.ts, shared with the admin Targets console.
 *
 * Targets are managed ONLY at /dashboard/admin/targets (user decision
 * 2026-07-31 — no inline editing on the project card). A target resolves
 * project override (project_targets) → type default (type_targets); inherited
 * rows are labelled "type default". Only metrics with an effective target
 * render; the section disappears entirely when there are none (admins get a
 * pointer to the console instead).
 */

export interface TargetsData {
  editable: boolean;                               // admin? → show manage link
  rows: { metric: string; target: number }[];      // project overrides
  typeRows: { metric: string; target: number }[];  // type defaults
  current: Record<string, number | null>;
}

export default function TargetsSection({ data }: { projectId: number; data: TargetsData | null }) {
  if (!data) return null;
  const override: Record<string, number | undefined> =
    Object.fromEntries((data.rows ?? []).map((r) => [r.metric, r.target]));
  const typeDefault: Record<string, number | undefined> =
    Object.fromEntries((data.typeRows ?? []).map((r) => [r.metric, r.target]));

  const visible = TARGET_METRICS.filter((m) => (override[m.key] ?? typeDefault[m.key]) != null);
  if (!visible.length && !data.editable) return null;

  return (
    <>
      <div className="hc-sub">
        Targets &amp; progress
        {data.editable && (
          <a href="/dashboard/admin/targets" className="bnl-sub"
            style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            manage →
          </a>
        )}
      </div>
      {!visible.length ? (
        <div className="bnl-sub">No targets set for this project or its type yet.</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {visible.map((m) => {
            const target = override[m.key] ?? typeDefault[m.key] ?? null;
            const inherited = override[m.key] == null;
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
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                <span style={{ minWidth: 150, color: 'var(--muted)' }}>{m.label}</span>
                <span style={{ minWidth: 60, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtTarget(cur, m.unit)}</span>
                <span style={{ flex: 1, minWidth: 120, height: 7, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${pct}%`,
                    background: met ? 'var(--accent)' : 'var(--warn)' }} />
                </span>
                <span className="bnl-sub" style={{ minWidth: 110 }}>
                  {`target ${m.higherBetter ? '≥' : '≤'} ${fmtTarget(target, m.unit)}${inherited ? ' · type default' : ''}`}
                  {met && <span style={{ color: 'var(--accent)', fontWeight: 700 }}> ✓</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
